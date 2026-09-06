"""Bounded reuse of public EJS preprocessing, separate from user/URL state.

The adapter targets yt-dlp 2026.08.19's private EJS hooks. Registration is
explicit; an untested yt-dlp version keeps its stock providers. Only serialized
preprocessed player code is retained, never request challenges or solutions.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from yt_dlp.extractor.youtube.jsc._builtin.deno import DenoJCP


class PlayerCache:
    """Thread-safe TTL/LRU of immutable bytes with a strict aggregate budget."""

    def __init__(
        self,
        *,
        max_bytes: int = 16 * 1024 * 1024,
        max_entries: int = 2,
        ttl: float = 3600,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_bytes = max_bytes
        self._max_entries = max_entries
        self._ttl = ttl
        self._clock = clock
        self._entries: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def _expire(self) -> None:
        now = self._clock()
        for key, (expires, _value) in list(self._entries.items()):
            if expires <= now:
                self._bytes -= len(self._entries.pop(key)[1])

    @property
    def byte_size(self) -> int:
        """Return retained serialized bytes after evicting expired players."""
        with self._lock:
            self._expire()
            return self._bytes

    def get(self, key: str) -> bytes | None:
        """Read one immutable payload; hits affect LRU, not expiration."""
        with self._lock:
            self._expire()
            entry = self._entries.get(key)
            if entry is None:
                return None
            self._entries.move_to_end(key)
            return entry[1]

    def put(self, key: str, value: bytes) -> None:
        """Retain a bounded payload, evicting least-recently-used players."""
        if len(value) > self._max_bytes or self._max_entries <= 0:
            return
        with self._lock:
            self._expire()
            old = self._entries.pop(key, None)
            if old is not None:
                self._bytes -= len(old[1])
            self._entries[key] = (self._clock() + self._ttl, value)
            self._bytes += len(value)
            while self._bytes > self._max_bytes or len(self._entries) > self._max_entries:
                self._bytes -= len(self._entries.popitem(last=False)[1][1])

    def discard(self, key: str) -> None:
        """Remove failed preprocessing without affecting other player versions."""
        with self._lock:
            old = self._entries.pop(key, None)
            if old is not None:
                self._bytes -= len(old[1])


_player_cache = PlayerCache()


@dataclass
class _SolveContext:
    key: str
    player: str
    requests: list[Any]
    cached: bool


def _successful_output(stdout: str) -> dict[str, Any] | None:
    try:
        value = json.loads(stdout)
    except (TypeError, ValueError):
        return None
    if not isinstance(value, dict) or value.get("type") == "error":
        return None
    responses = value.get("responses")
    if not isinstance(responses, list) or not responses:
        return None
    if not all(isinstance(item, dict) and item.get("type") != "error" for item in responses):
        return None
    return value


class SoundspanDenoJCP(DenoJCP):  # type: ignore[misc,no-any-unimported]  # yt-dlp has no PEP 561 types.
    """Reuse code preprocessing while evaluating every request independently.

    Cached execution failures retry the original player exactly once. The
    stock Deno provider stays registered as yt-dlp's final fallback.
    """

    PROVIDER_NAME = "soundspan_deno"

    def _construct_stdin(self, player: str, preprocessed: bool, requests: list[Any], /) -> str:
        self._solve_context: _SolveContext | None = None
        if preprocessed or getattr(self, "is_dev", False):
            return str(super()._construct_stdin(player, preprocessed, requests))
        key = hashlib.sha256((self._SCRIPT_VERSION + "\0" + player).encode()).hexdigest()
        payload = _player_cache.get(key)
        prepared = json.loads(payload) if payload is not None else None
        self._solve_context = _SolveContext(key, player, requests, prepared is not None)
        return str(
            super()._construct_stdin(
                prepared if prepared is not None else player, prepared is not None, requests
            )
        )

    def _run_js_runtime(self, stdin: str, /) -> str:
        context = self._solve_context
        self._solve_context = None
        if context is None:
            return str(super()._run_js_runtime(stdin))
        try:
            result = str(super()._run_js_runtime(stdin))
        except Exception:
            if not context.cached:
                raise
            # A failed optimization must not lose the original request.
            result = ""
        parsed = _successful_output(result)
        if context.cached and parsed is None:
            _player_cache.discard(context.key)
            original = super()._construct_stdin(context.player, False, context.requests)
            result = str(super()._run_js_runtime(original))
            parsed = _successful_output(result)
        if parsed is not None and (prepared := parsed.get("preprocessed_player")):
            payload = json.dumps(prepared, separators=(",", ":")).encode()
            _player_cache.put(context.key, payload)
        return result


_registration_lock = threading.Lock()
_registered = False


def register_player_cache() -> bool:
    """Opt into the tested adapter once; unknown upstream versions stay stock."""
    from yt_dlp.extractor.youtube.jsc.provider import register_preference, register_provider
    from yt_dlp.version import __version__

    global _registered
    if __version__ != "2026.08.19":
        return False
    with _registration_lock:
        if not _registered:
            register_provider(SoundspanDenoJCP)
            register_preference(SoundspanDenoJCP)(lambda _provider, _requests: 100)
            _registered = True
    return True
