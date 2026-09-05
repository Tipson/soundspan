"""Explicit production burst probe, run via stdin INSIDE the existing sidecar.

Only loopback /health and /proxy are used; no account history or config writes.
Stages cap at ten. Stop on the first error, >8s first byte, or >75% cgroup memory.
This tests provider delivery, not authenticated frontend capacity or audible sound.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx


def parse_stages(value: str) -> list[int]:
    """Permit only explicit, increasing small stages; never an accidental 100 burst."""
    stages = [int(part) for part in value.split(",")]
    if not stages or any(stage < 1 or stage > 10 for stage in stages):
        raise ValueError("Stages must be between 1 and 10")
    if stages != sorted(set(stages)):
        raise ValueError("Stages must be strictly increasing")
    return stages


def accepted(result: dict[str, Any]) -> bool:
    """Stop policy is stricter than eventual HTTP success."""
    return bool(
        not result.get("error")
        and result.get("status") in {200, 206}
        and 0 <= result.get("firstByteMs", -1) <= 8000
        and result.get("bytesRead", 0) > 0
    )


def memory_ratio() -> float:
    """Read the existing container's memory accounting without changing limits."""
    root = Path("/sys/fs/cgroup")
    maximum = (root / "memory.max").read_text().strip()
    if maximum == "max":
        raise RuntimeError("A finite container memory limit is required")
    return int((root / "memory.current").read_text()) / int(maximum)


def spool_hint(video_id: str) -> str:
    """A file-presence hint, not proof of provider cache hit or actual upstream calls."""
    root = Path(
        os.getenv("YTMUSIC_SPOOL_DIR") or Path(tempfile.gettempdir()) / "soundspan-ytmusic-spool"
    )
    return "file-present" if any(root.glob(f"{video_id}-HIGH.*")) else "file-absent"


async def run(stages: list[int], ids: list[str]) -> bool:
    """Own every request and cancel sibling work immediately after a failed request."""
    secret = os.environ.get("INTERNAL_API_SECRET")
    if not secret or not await asyncio.to_thread(Path("/app/app.py").is_file):
        raise RuntimeError("Run inside the configured sidecar; no secrets in arguments")
    async with httpx.AsyncClient(
        base_url="http://127.0.0.1:8586",
        trust_env=False,
        headers={"x-internal-secret": secret},
        timeout=httpx.Timeout(8, connect=3),
        limits=httpx.Limits(max_connections=10),
        follow_redirects=False,
    ) as client:
        for stage in stages:
            before = await asyncio.to_thread(memory_ratio)
            health = await client.get("/health", timeout=3)
            if before >= 0.75 or health.status_code != 200:
                sys.stdout.write(
                    json.dumps(
                        {"stage": stage, "stop": "baseline-health-or-memory", "memoryRatio": before}
                    )
                    + "\n",
                )
                sys.stdout.flush()
                return False
            results: list[dict[str, Any]] = []

            async def sample(index: int, video_id: str, results: list[dict[str, Any]]) -> None:
                result: dict[str, Any] = {"sample": index, "bytesRead": 0}
                results.append(result)
                result["spoolBefore"] = await asyncio.to_thread(spool_hint, video_id)
                started = time.monotonic()
                memory_checked_at = started
                try:
                    async with asyncio.timeout(30):
                        async with client.stream(
                            "GET",
                            f"/proxy/{video_id}",
                            params={
                                "user_id": "__public__",
                                "quality": "HIGH",
                                "purpose": "interactive",
                            },
                            headers={"Range": "bytes=0-"},
                        ) as response:
                            result["status"] = response.status_code
                            result["headersMs"] = round((time.monotonic() - started) * 1000, 1)
                            if response.status_code not in {200, 206} or not response.headers.get(
                                "content-type", ""
                            ).split(";")[0].startswith(("audio/", "video/webm")):
                                raise RuntimeError("RejectedAudioResponse")
                            async for chunk in response.aiter_bytes():
                                if not chunk:
                                    continue
                                result.setdefault(
                                    "firstByteMs", round((time.monotonic() - started) * 1000, 1)
                                )
                                result["bytesRead"] += len(chunk)
                                if time.monotonic() - memory_checked_at >= 1:
                                    if await asyncio.to_thread(memory_ratio) >= 0.75:
                                        raise RuntimeError("MemoryLimit")
                                    memory_checked_at = time.monotonic()
                                if not accepted(result) or result["bytesRead"] > 16 * 1024 * 1024:
                                    raise RuntimeError("LatencyOrSizeLimit")
                            result["complete"] = True
                    if not accepted(result):
                        raise RuntimeError("EmptyAudioResponse")
                except asyncio.CancelledError:
                    result["error"] = "CancelledAfterSiblingFailure"
                    raise
                except Exception as error:
                    result["error"] = type(error).__name__
                    raise
                finally:
                    result["elapsedMs"] = round((time.monotonic() - started) * 1000, 1)

            failed = False
            try:
                async with asyncio.TaskGroup() as group:
                    for index, video_id in enumerate(ids[:stage]):
                        group.create_task(sample(index, video_id, results))
            except ExceptionGroup:
                failed = True
            after = await asyncio.to_thread(memory_ratio)
            health = await client.get("/health", timeout=3)
            stopped = failed or after >= 0.75 or health.status_code != 200
            sys.stdout.write(
                json.dumps(
                    {
                        "stage": stage,
                        "boundary": "production-sidecar-loopback-real-upstream-unmodified",
                        "memoryBefore": before,
                        "memoryAfter": after,
                        "healthAfter": health.status_code,
                        "stopped": stopped,
                        "results": results,
                    }
                )
                + "\n",
            )
            sys.stdout.flush()
            if stopped:
                return False
            await asyncio.sleep(3)
    return True


def main() -> int:
    """Parse operator-selected stages and public IDs before any production request."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stages", default="1")
    parser.add_argument("--ids", required=True)
    args = parser.parse_args()
    stages = parse_stages(args.stages)
    ids = args.ids.split(",")
    if (
        len(ids) < max(stages)
        or len(set(ids)) != len(ids)
        or not all(re.fullmatch(r"[A-Za-z0-9_-]{11}", value) for value in ids)
    ):
        parser.error("Provide enough distinct 11-character public video IDs")
    return 0 if asyncio.run(run(stages, ids)) else 2


if __name__ == "__main__":
    raise SystemExit(main())
