"""One process-wide heavy-work budget across playback and metadata executors."""

import threading
import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


class ExtractionAbandoned(Exception):
    """A queued request was cancelled or expired before provider work started."""


class ExtractionBudget:
    """Hold a slot until the real worker exits, prioritizing waiting playback.

    HTTP cancellation cannot kill a running Python thread or its Deno child.
    Releasing a slot when only the HTTP waiter ends would defeat this bound.
    """

    def __init__(self, limit: int) -> None:
        if limit < 1:
            raise ValueError("Extraction limit must be positive")
        self._limit = limit
        self._active = 0
        self._playback_waiters = 0
        self._condition = threading.Condition()

    def run(
        self,
        operation: Callable[[], T],
        *,
        playback: bool = False,
        cancel_event: threading.Event | None = None,
        deadline: float | None = None,
    ) -> T:
        """Run work with a cancellable wait and a slot owned by its thread."""
        with self._condition:
            if playback:
                self._playback_waiters += 1
            try:
                while True:
                    if (cancel_event is not None and cancel_event.is_set()) or (
                        deadline is not None and time.monotonic() >= deadline
                    ):
                        raise ExtractionAbandoned("Queued extraction was abandoned")
                    if self._active < self._limit and (playback or not self._playback_waiters):
                        self._active += 1
                        break
                    self._condition.wait(timeout=0.05)
            finally:
                if playback:
                    self._playback_waiters -= 1
                    self._condition.notify_all()
        try:
            return operation()
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()
