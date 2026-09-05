"""Bounded internal handoff of AcoustID identity to the backend merge owner."""

from __future__ import annotations

import http.client
import json
import time
from collections.abc import Callable
from typing import Literal
from urllib.parse import urlsplit

MAX_RESPONSE_BYTES = 16 * 1024
RESPONSE_READ_CHUNK_BYTES = 4 * 1024
REQUEST_TIMEOUT_SECONDS = 3.0
MAX_ATTEMPTS = 3
RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
PROMOTION_PATH = "/api/internal/canonical-identity/promotions"

PromotionAdmission = Literal["accepted", "stale"]


class CanonicalIdentityPromotionError(RuntimeError):
    """Describe a bounded transport or protocol failure without secrets."""


def _set_response_socket_timeout(response: object, timeout: float) -> None:
    """Apply the remaining total budget to http.client's active socket."""
    file_pointer = getattr(response, "fp", None)
    raw_stream = getattr(file_pointer, "raw", None)
    response_socket = getattr(raw_stream, "_sock", None)
    if response_socket is not None:
        response_socket.settimeout(timeout)


def _set_connection_socket_timeout(connection: object, timeout: float) -> None:
    """Tighten the active connection before parsing response headers."""
    connection_socket = getattr(connection, "sock", None)
    if connection_socket is not None:
        connection_socket.settimeout(timeout)


def _read_response(
    response: object,
    deadline: float,
    clock: Callable[[], float],
) -> bytes:
    """Read a bounded response without allowing slow trickle past deadline."""
    payload = bytearray()
    read1 = getattr(response, "read1", None)
    if not callable(read1):
        raise CanonicalIdentityPromotionError(
            "Canonical identity promotion response has no bounded reader"
        )
    for _ in range((MAX_RESPONSE_BYTES // RESPONSE_READ_CHUNK_BYTES) + 2):
        remaining = deadline - clock()
        if remaining <= 0:
            raise TimeoutError("Canonical identity promotion deadline exceeded")
        _set_response_socket_timeout(response, remaining)
        chunk = read1(min(RESPONSE_READ_CHUNK_BYTES, MAX_RESPONSE_BYTES + 1 - len(payload)))
        if clock() >= deadline:
            raise TimeoutError("Canonical identity promotion deadline exceeded")
        if not isinstance(chunk, bytes):
            raise CanonicalIdentityPromotionError(
                "Canonical identity promotion returned non-bytes data"
            )
        if not chunk:
            return bytes(payload)
        payload.extend(chunk)
        if len(payload) > MAX_RESPONSE_BYTES:
            raise CanonicalIdentityPromotionError(
                "Canonical identity promotion response exceeded its limit"
            )
    raise CanonicalIdentityPromotionError(
        "Canonical identity promotion response exceeded its limit"
    )


def _sleep_before_retry(attempt: int) -> None:
    time.sleep(0.2 * (2 ** (attempt - 1)))


class CanonicalIdentityPromotionClient:
    """Submit one replay-safe promotion intent over the private backend API."""

    def __init__(
        self,
        base_url: str,
        internal_api_secret: str,
        *,
        timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
        attempts: int = MAX_ATTEMPTS,
        retry_sleep: Callable[[int], None] = _sleep_before_retry,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        parsed = urlsplit(base_url.strip())
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("BACKEND_INTERNAL_URL must be an HTTP(S) origin")
        if not internal_api_secret:
            raise ValueError("INTERNAL_API_SECRET is required for identity promotion")
        self._scheme = parsed.scheme
        self._host = parsed.hostname
        self._port = parsed.port
        self._path = PROMOTION_PATH
        self._secret = internal_api_secret
        self._timeout_seconds = max(0.1, min(10.0, timeout_seconds))
        self._attempts = max(1, min(5, attempts))
        self._retry_sleep = retry_sleep
        self._clock = clock

    def submit(
        self,
        *,
        source_canonical_id: str,
        expected_fingerprint: str,
        recording_mbid: str,
        confidence: float,
    ) -> PromotionAdmission:
        """Return backend admission; retry only transient transport failures."""
        body = json.dumps(
            {
                "sourceCanonicalId": source_canonical_id,
                "expectedFingerprint": expected_fingerprint,
                "recordingMbid": recording_mbid,
                "confidence": confidence,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        last_error: Exception | None = None
        for attempt in range(1, self._attempts + 1):
            deadline = self._clock() + self._timeout_seconds
            connection_type = (
                http.client.HTTPSConnection
                if self._scheme == "https"
                else http.client.HTTPConnection
            )
            connection = connection_type(
                self._host,
                self._port,
                timeout=self._timeout_seconds,
            )
            try:
                connection.request(
                    "POST",
                    self._path,
                    body=body,
                    headers={
                        "content-type": "application/json",
                        "content-length": str(len(body)),
                        "x-internal-secret": self._secret,
                    },
                )
                remaining = deadline - self._clock()
                if remaining <= 0:
                    raise TimeoutError("Canonical identity promotion deadline exceeded")
                _set_connection_socket_timeout(connection, remaining)
                response = connection.getresponse()
                if self._clock() >= deadline:
                    raise TimeoutError("Canonical identity promotion deadline exceeded")
                response_body = _read_response(response, deadline, self._clock)
                if response.status in {202, 409}:
                    try:
                        payload = json.loads(response_body)
                    except (UnicodeDecodeError, json.JSONDecodeError) as error:
                        raise CanonicalIdentityPromotionError(
                            "Canonical identity promotion returned invalid JSON"
                        ) from error
                    status = payload.get("status") if isinstance(payload, dict) else None
                    expected: PromotionAdmission = "accepted" if response.status == 202 else "stale"
                    if status != expected:
                        raise CanonicalIdentityPromotionError(
                            "Canonical identity promotion returned an invalid status"
                        )
                    return expected
                if response.status not in RETRYABLE_STATUS_CODES:
                    raise CanonicalIdentityPromotionError(
                        f"Canonical identity promotion was rejected ({response.status})"
                    )
                last_error = CanonicalIdentityPromotionError(
                    f"Canonical identity promotion unavailable ({response.status})"
                )
            except (OSError, TimeoutError, http.client.HTTPException) as error:
                last_error = error
            finally:
                connection.close()
            if attempt < self._attempts:
                self._retry_sleep(attempt)
        raise CanonicalIdentityPromotionError(
            "Canonical identity promotion remained unavailable"
        ) from last_error
