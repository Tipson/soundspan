#!/usr/bin/env python3
"""Bounded public music-route probe with durable, administrator-only incidents.

Runs on a Linux Docker host without third-party Python dependencies. Credentials
are minted inside the existing backend container and never persisted or logged.
"""

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

CHUNK_BYTES = 256 * 1024
FAILURE_THRESHOLD = 3
RECOVERY_THRESHOLD = 2
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")


class ProbeFailure(Exception):
    """A safe machine-readable failure; never holds response bodies or tokens."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class Config:
    """Operator-owned target and bounds; no signing key or permanent token."""

    origin: str
    test_user_id: str
    seed_video_ids: tuple
    compose_project: str
    interval_seconds: int = 900
    timeout_seconds: int = 60

    @classmethod
    def from_dict(cls, raw, *, allow_loopback_http=False):
        """Validate configuration, permitting HTTP only in loopback test fixtures."""
        required = {"origin", "test_user_id", "seed_video_ids", "compose_project"}
        if (
            not isinstance(raw, dict)
            or not required <= raw.keys()
            or raw.keys() - required - {"interval_seconds", "timeout_seconds"}
        ):
            raise ValueError("invalid_config")
        origin = raw["origin"]
        if not isinstance(origin, str):
            raise ValueError("invalid_origin")
        parsed = urlsplit(origin)
        local_http = (
            allow_loopback_http
            and parsed.scheme == "http"
            and parsed.hostname in {"127.0.0.1", "::1"}
        )
        if (
            (parsed.scheme != "https" and not local_http)
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("invalid_origin")
        try:
            _ = parsed.port
        except ValueError as exc:
            raise ValueError("invalid_origin") from exc
        for field in ["test_user_id", "compose_project"]:
            if not isinstance(raw[field], str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{1,100}", raw[field]
            ):
                raise ValueError("invalid_config")
        seeds = raw["seed_video_ids"]
        if (
            not isinstance(seeds, list)
            or not 1 <= len(seeds) <= 3
            or any(not isinstance(seed, str) or not VIDEO_ID.fullmatch(seed) for seed in seeds)
        ):
            raise ValueError("invalid_seed")
        interval, timeout = raw.get("interval_seconds", 900), raw.get("timeout_seconds", 60)
        if (
            type(interval) is not int
            or not 900 <= interval <= 86400
            or type(timeout) is not int
            or not 5 <= timeout <= 60
        ):
            raise ValueError("invalid_bounds")
        return cls(
            origin, raw["test_user_id"], tuple(seeds), raw["compose_project"], interval, timeout
        )

    def fingerprint(self):
        """Bind persisted incidents to one target and its probe configuration."""
        return hashlib.sha256(json.dumps(self.__dict__, sort_keys=True).encode()).hexdigest()


class NoRedirect(HTTPRedirectHandler):
    """Do not forward an authenticated request to another URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(config, token, seed):
    """Apply a Linux wall-clock bound including DNS, TLS and HTTP headers.

    The operator runs on the main thread of an isolated Linux process. Windows
    unit fixtures use the per-read/body guard; Windows is not an operator host.
    """
    if not hasattr(signal, "setitimer"):
        return _probe(config, token, seed)

    def expire(signum, frame):
        raise ProbeFailure("timeout")

    previous_handler = signal.signal(signal.SIGALRM, expire)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, config.timeout_seconds)
    started = time.monotonic()
    try:
        return _probe(config, token, seed)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0]:
            signal.setitimer(
                signal.ITIMER_REAL,
                max(0.000001, previous_timer[0] - (time.monotonic() - started)),
                previous_timer[1],
            )


def _probe(config, token, seed):
    """Fetch public radio and two consecutive audio ranges within a deadline.

    Uses GET-only routes which do not record plays or recommendation exposures.
    Requires real partial audio responses, exact bytes and a consistent total.
    """
    deadline = time.monotonic() + config.timeout_seconds
    opener = build_opener(NoRedirect())

    def request(path, max_bytes, byte_range=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeFailure("timeout")
        headers = {
            "Authorization": f"Bearer {token}",
            "Connection": "close",
            "Accept-Encoding": "identity",
        }
        if byte_range:
            headers["Range"] = byte_range
        # Config allows HTTPS only; the HTTP exception is loopback test-only.
        req = Request(config.origin + path, headers=headers, method="GET")  # noqa: S310
        try:
            # read1 performs at most one socket read; trickling responses cannot
            # reset the overall deadline inside one unbounded read(size).
            with opener.open(req, timeout=min(5, remaining)) as response:
                content = bytearray()
                while True:
                    if time.monotonic() >= deadline:
                        raise ProbeFailure("timeout")
                    chunk = response.read1(min(16384, max_bytes + 1 - len(content)))
                    if time.monotonic() >= deadline:
                        raise ProbeFailure("timeout")
                    if not chunk:
                        break
                    content.extend(chunk)
                    if len(content) > max_bytes:
                        raise ProbeFailure("response_size")
                return response.status, response.headers, bytes(content)
        except HTTPError as exc:
            exc.close()
            raise ProbeFailure(f"http_{exc.code}") from None
        except TimeoutError:
            raise ProbeFailure("timeout") from None
        except (URLError, OSError, HTTPException):
            raise ProbeFailure("network") from None

    status, headers, body = request(
        "/api/library/radio?" + urlencode({"type": "youtube", "value": seed, "limit": 5}),
        1024 * 1024,
    )
    if status != 200 or headers.get_content_type() != "application/json":
        raise ProbeFailure("radio_response")
    try:
        tracks = json.loads(body)["tracks"]
        if not isinstance(tracks, list) or not any(
            isinstance(track, dict) and VIDEO_ID.fullmatch(str(track.get("youtubeVideoId", "")))
            for track in tracks
        ):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ProbeFailure("radio_response") from None

    total = None
    for start in [0, CHUNK_BYTES]:
        end = start + CHUNK_BYTES - 1
        status, headers, body = request(
            f"/api/ytmusic/stream-public/{seed}?quality=HIGH", CHUNK_BYTES, f"bytes={start}-{end}"
        )
        mime = headers.get_content_type()
        if status != 206 or not (
            mime.startswith("audio/") or mime in {"video/webm", "application/octet-stream"}
        ):
            raise ProbeFailure("audio_response")
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", headers.get("Content-Range", ""))
        if not match or tuple(map(int, match.groups()[:2])) != (start, end):
            raise ProbeFailure("audio_range")
        current_total = int(match.group(3))
        if current_total <= end or (total is not None and current_total != total):
            raise ProbeFailure("audio_range")
        total = current_total
        if headers.get("Content-Length") != str(CHUNK_BYTES) or len(body) != CHUNK_BYTES:
            raise ProbeFailure("audio_body")
    return {"bytesRead": CHUNK_BYTES * 2, "radioTracks": len(tracks)}


class RuntimeAdapter:
    """Invoke code inside a single running Compose API without a shell."""

    def __init__(self, project):
        self.project = project
        self.container = None
        self.source = (
            Path(__file__).with_name("music-route-runtime.cjs").read_text(encoding="utf-8")
        )

    def call(self, mode, payload):
        """Return only a marked JSON reply, discarding ordinary runtime logs."""
        try:
            if self.container is None:
                # Project label is validated by Config; no shell is involved.
                result = subprocess.run(  # noqa: S603
                    [
                        "/usr/bin/docker",
                        "ps",
                        "--filter",
                        f"label=com.docker.compose.project={self.project}",
                        "--filter",
                        "label=com.docker.compose.service=backend",
                        "--format",
                        "{{.ID}}",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=True,
                )
                containers = result.stdout.split()
                if len(containers) != 1 or not re.fullmatch(r"[0-9a-f]{12,64}", containers[0]):
                    raise ProbeFailure("runtime_backend")
                self.container = containers[0]
            # Container ID is hex-only; helper code is an operator-owned file.
            result = subprocess.run(  # noqa: S603
                [
                    "/usr/bin/docker",
                    "exec",
                    "-i",
                    "-w",
                    "/app",
                    self.container,
                    "node",
                    "-e",
                    self.source,
                    mode,
                ],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=20,
                check=True,
            )
            replies = [
                line.removeprefix("SOUNDSPAN_MONITOR:")
                for line in result.stdout.splitlines()
                if line.startswith("SOUNDSPAN_MONITOR:")
            ]
            if len(replies) != 1:
                raise ProbeFailure("runtime_reply")
            reply = json.loads(replies[0])
            if not isinstance(reply, dict):
                raise ValueError()
            return reply
        except (subprocess.SubprocessError, OSError, ValueError):
            raise ProbeFailure(
                "runtime_auth" if mode == "token" else "runtime_notification"
            ) from None

    def token(self, user_id):
        """Mint an ephemeral JWT without storing it in command arguments."""
        reply = self.call("token", {"userId": user_id})
        token = reply.get("token")
        if not isinstance(token, str) or not token or len(token) > 4096:
            raise ProbeFailure("runtime_reply")
        return token

    def notify(self, event):
        """Retry an idempotent administrator event; errors remain pending."""
        if self.call("notify", event).get("delivered") is not True:
            raise ProbeFailure("runtime_notification")


def save_state(path, state):
    """Atomically persist private state before attempting external delivery."""
    temp = path.with_suffix(".tmp")
    fd = os.open(temp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(state, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    if os.name == "posix":
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def tick(config, state_path, adapter, now, probe_fn=probe):
    """Advance one persistent incident, enforcing cadence across restarts."""
    if state_path.exists():
        if state_path.stat().st_size > 65536:
            raise ValueError("invalid_state")
        state = json.loads(state_path.read_text(encoding="utf-8"))
        try:
            if (
                state["schema"] != 1
                or state["target"] != config.fingerprint()
                or not isinstance(state["pending"], list)
            ):
                raise ValueError("invalid_state")
            for field in ["last_checked", "runs", "failures", "successes"]:
                if type(state[field]) is not int or state[field] < 0:
                    raise ValueError("invalid_state")
            if state["incident_id"] is not None:
                uuid.UUID(state["incident_id"])
            for event in state["pending"]:
                uuid.UUID(event["incidentId"])
                if event["kind"] not in {"outage", "recovery"}:
                    raise ValueError("invalid_state")
        except (KeyError, TypeError, AttributeError):
            raise ValueError("invalid_state") from None
    else:
        state = {
            "schema": 1,
            "target": config.fingerprint(),
            "last_checked": 0,
            "runs": 0,
            "failures": 0,
            "successes": 0,
            "incident_id": None,
            "pending": [],
        }
    if state["runs"] and now < state["last_checked"] + config.interval_seconds:
        return {"status": "cooldown", "pending": len(state["pending"])}
    code = None
    try:
        token = adapter.token(config.test_user_id)
        metrics = probe_fn(
            config, token, config.seed_video_ids[state["runs"] % len(config.seed_video_ids)]
        )
    except ProbeFailure as exc:
        code = exc.code
        metrics = {}
    state["last_checked"] = int(now)
    state["runs"] += 1
    if code:
        state["failures"] += 1
        state["successes"] = 0
        if state["failures"] >= FAILURE_THRESHOLD and state["incident_id"] is None:
            state["incident_id"] = str(uuid.uuid4())
            state["pending"].append(
                {"incidentId": state["incident_id"], "kind": "outage", "code": code}
            )
    else:
        state["successes"] += 1
        state["failures"] = 0
        if state["successes"] >= RECOVERY_THRESHOLD and state["incident_id"]:
            state["pending"].append(
                {"incidentId": state["incident_id"], "kind": "recovery", "code": "ok"}
            )
            state["incident_id"] = None
    save_state(state_path, state)
    notification_failed = False
    while state["pending"]:
        try:
            adapter.notify(state["pending"][0])
        except Exception:
            notification_failed = True
            break
        state["pending"].pop(0)
        save_state(state_path, state)
    return {
        "status": "failure" if code else "ok",
        "code": code,
        "failures": state["failures"],
        "pending": len(state["pending"]),
        "notificationFailed": notification_failed,
        **metrics,
    }


def main():
    """Run a serialized Linux operator tick and emit credential-free JSON."""
    import fcntl

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.config.is_symlink() or args.config.stat().st_mode & 0o077:
            raise ValueError("private_config_required")
        config = Config.from_dict(json.loads(args.config.read_text(encoding="utf-8")))
        args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with args.state.with_suffix(".lock").open("w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                sys.stdout.write(json.dumps({"status": "already_running"}) + "\n")
                return 0
            result = tick(
                config, args.state, RuntimeAdapter(config.compose_project), int(time.time())
            )
        sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
        return 0
    except Exception:
        # Exceptions can contain HTTP/child-process data: do not render them.
        sys.stdout.write(
            json.dumps({"status": "monitor_error", "code": "operator_config_or_state"}) + "\n"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
