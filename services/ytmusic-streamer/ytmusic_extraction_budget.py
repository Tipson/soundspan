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
        # When capacity allows it, keep one slot available for the listener.
        # Metadata, preloads and remote analysis may share the remaining slots.
        self._background_limit = max(1, limit - 1)
        self._active = 0
        self._background_active = 0
        self._playback_waiters = 0
        self._priority_waiters = [0, 0, 0]
        self._condition = threading.Condition()

    def notify_priority_change(self) -> None:
        """Wake queued work after an external owner promotes its priority."""
        with self._condition:
            self._condition.notify_all()

    def run(
        self,
        operation: Callable[[], T],
        *,
        playback: bool = False,
        cancel_event: threading.Event | None = None,
        deadline: float | None = None,
        priority: Callable[[], int] | None = None,
    ) -> T:
        """Run work with a cancellable, dynamically promotable priority wait.

        Priority zero is background work, one is speculative preload, and two
        is current playback. The legacy ``playback=True`` API maps to two.
        """
        registered_priority: int | None = None
        acquired_priority = 0

        def observed_priority() -> int:
            if playback:
                return 2
            if priority is None:
                return 0
            return max(0, min(2, int(priority())))

        with self._condition:
            try:
                while True:
                    requested_priority = observed_priority()
                    if requested_priority != registered_priority:
                        if registered_priority is not None:
                            self._priority_waiters[registered_priority] -= 1
                        self._priority_waiters[requested_priority] += 1
                        registered_priority = requested_priority
                        self._playback_waiters = self._priority_waiters[2]
                        self._condition.notify_all()
                    if (cancel_event is not None and cancel_event.is_set()) or (
                        deadline is not None and time.monotonic() >= deadline
                    ):
                        raise ExtractionAbandoned("Queued extraction was abandoned")
                    within_priority_capacity = requested_priority == 2 or (
                        self._background_active < self._background_limit
                    )
                    higher_priority_waiting = any(
                        self._priority_waiters[level] for level in range(requested_priority + 1, 3)
                    )
                    if (
                        self._active < self._limit
                        and within_priority_capacity
                        and not higher_priority_waiting
                    ):
                        self._active += 1
                        acquired_priority = requested_priority
                        if acquired_priority < 2:
                            self._background_active += 1
                        break
                    self._condition.wait(timeout=0.05)
            finally:
                if registered_priority is not None:
                    self._priority_waiters[registered_priority] -= 1
                    self._playback_waiters = self._priority_waiters[2]
                    self._condition.notify_all()
        try:
            return operation()
        finally:
            with self._condition:
                self._active -= 1
                if acquired_priority < 2:
                    self._background_active -= 1
                self._condition.notify_all()
