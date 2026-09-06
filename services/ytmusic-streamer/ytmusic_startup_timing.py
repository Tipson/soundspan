"""Bounded monotonic checkpoints for one shared audio startup, without URLs."""

import threading
import time
from collections.abc import Callable
from typing import Literal

StartupPhase = Literal["resolve_start", "resolved", "transfer_start", "first_chunk", "readable"]


class SpoolStartupTiming:
    """Retain first occurrences so shared readers and retries cannot reset elapsed time."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._started = clock()
        self._marks: dict[str, int] = {}
        self._lock = threading.Lock()

    def mark(self, phase: StartupPhase) -> None:
        """Record a stage once; values are milliseconds since task creation."""
        with self._lock:
            if phase not in self._marks:
                self._marks[phase] = round((self._clock() - self._started) * 1000)

    def snapshot(self) -> dict[str, int]:
        """Return an independent log-safe snapshot, not a mutable shared mapping."""
        with self._lock:
            return dict(self._marks)
