"""Preserve extraction pacing while prioritizing interactive listeners."""

import random
import threading
import time
from collections.abc import Callable

from ytmusic_extraction_budget import ExtractionAbandoned

from services.common.sidecar_runtime_utils import ThreadSafeRatePacer


class PriorityRatePacer(ThreadSafeRatePacer):
    """Choose the highest-priority waiter at the next allowed request time.

    Sleeping waiters release the condition lock, so a preload cannot reserve
    the next slot ahead of newly arrived playback. Equal priorities stay FIFO.
    Priority callbacks are captured in the calling thread and may track a
    preload's promotion to playback. The existing worker pools bound waiters.
    """

    def __init__(
        self,
        min_delay: float,
        max_delay: float,
        *,
        priority: Callable[[], Callable[[], int]],
        clock: Callable[[], float] = time.monotonic,
        max_wait: float = 60,
        cancelled: Callable[[], bool] = lambda: False,
    ) -> None:
        super().__init__(min_delay, max_delay)
        self._priority = priority
        self._clock = clock
        self._max_wait = max_wait
        self._cancelled = cancelled
        self._condition = threading.Condition(self._lock)
        self._waiters: dict[object, Callable[[], int]] = {}

    def wait(self) -> float:
        """Wait without reserving a future slot or allowing a catch-up burst."""
        requested_priority = self._priority()
        started = self._clock()
        token = object()
        with self._condition:
            self._waiters[token] = requested_priority
            try:
                while True:
                    if self._cancelled() or self._clock() - started >= self._max_wait:
                        raise ExtractionAbandoned("Paced extraction was abandoned")
                    remaining = self._next_allowed - self._clock()
                    selected = max(self._waiters, key=lambda item: self._waiters[item]())
                    if selected is token and remaining <= 0:
                        admitted = self._clock()
                        gap = random.uniform(self._min, self._max)  # noqa: S311 -- non-security pacing jitter
                        self._next_allowed = admitted + gap
                        return max(0.0, admitted - started)
                    self._condition.wait(timeout=min(0.05, max(0.01, remaining)))
            finally:
                self._waiters.pop(token, None)
                self._condition.notify_all()
