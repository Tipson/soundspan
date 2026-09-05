"""Contract tests for the bounded private canonical identity handoff."""

from __future__ import annotations

import json
from typing import Any, ClassVar

import canonical_identity_client
import pytest
from canonical_identity_client import (
    CanonicalIdentityPromotionClient,
    CanonicalIdentityPromotionError,
)


class _Response:
    def __init__(self, status: int, body: dict[str, object]) -> None:
        self.status = status
        self._body = json.dumps(body).encode()
        self._offset = 0

    def read(self, limit: int) -> bytes:
        chunk = self._body[self._offset : self._offset + limit]
        self._offset += len(chunk)
        return chunk

    def read1(self, limit: int) -> bytes:
        return self.read(limit)


class _Connection:
    responses: ClassVar[list[_Response]] = []
    calls: ClassVar[list[dict[str, Any]]] = []

    def __init__(self, host: str, port: int | None, *, timeout: float) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes,
        headers: dict[str, str],
    ) -> None:
        self.calls.append(
            {
                "method": method,
                "path": path,
                "body": json.loads(body),
                "headers": headers,
                "timeout": self.timeout,
            }
        )

    def getresponse(self) -> _Response:
        return self.responses.pop(0)

    def close(self) -> None:
        return None


@pytest.fixture(autouse=True)
def fake_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    _Connection.responses = []
    _Connection.calls = []
    monkeypatch.setattr(canonical_identity_client.http.client, "HTTPConnection", _Connection)


def _client(
    *, attempts: int = 3, sleeps: list[int] | None = None
) -> CanonicalIdentityPromotionClient:
    observed_sleeps = sleeps if sleeps is not None else []
    return CanonicalIdentityPromotionClient(
        "http://backend:3006",
        "internal-test-secret",
        attempts=attempts,
        retry_sleep=observed_sleeps.append,
    )


def _submit(client: CanonicalIdentityPromotionClient) -> str:
    return client.submit(
        source_canonical_id="canonical-source",
        expected_fingerprint="fingerprint",
        recording_mbid="recording-mbid",
        confidence=0.99,
    )


@pytest.mark.parametrize(
    ("status_code", "status"),
    [(202, "accepted"), (409, "stale")],
)
def test_returns_only_valid_backend_admission(status_code: int, status: str) -> None:
    _Connection.responses = [_Response(status_code, {"status": status})]

    assert _submit(_client()) == status
    assert _Connection.calls == [
        {
            "method": "POST",
            "path": "/api/internal/canonical-identity/promotions",
            "body": {
                "sourceCanonicalId": "canonical-source",
                "expectedFingerprint": "fingerprint",
                "recordingMbid": "recording-mbid",
                "confidence": 0.99,
            },
            "headers": {
                "content-type": "application/json",
                "content-length": "127",
                "x-internal-secret": "internal-test-secret",
            },
            "timeout": 3.0,
        }
    ]


def test_retries_transient_status_with_a_strict_attempt_bound() -> None:
    sleeps: list[int] = []
    _Connection.responses = [
        _Response(503, {"error": "unavailable"}),
        _Response(202, {"status": "accepted"}),
    ]

    assert _submit(_client(attempts=2, sleeps=sleeps)) == "accepted"
    assert len(_Connection.calls) == 2
    assert sleeps == [1]


def test_rejects_non_retryable_or_invalid_protocol_responses() -> None:
    _Connection.responses = [_Response(403, {"error": "Forbidden"})]
    with pytest.raises(CanonicalIdentityPromotionError, match=r"rejected \(403\)"):
        _submit(_client())
    assert len(_Connection.calls) == 1

    _Connection.responses = [_Response(202, {"status": "unexpected"})]
    with pytest.raises(CanonicalIdentityPromotionError, match="invalid status"):
        _submit(_client())


@pytest.mark.parametrize(
    "url",
    [
        "",
        "ftp://backend",
        "http://user:secret@backend",
        "http://backend?q=secret",
        "http://backend/unexpected-path",
    ],
)
def test_rejects_unsafe_internal_origins(url: str) -> None:
    with pytest.raises(ValueError, match=r"HTTP\(S\) origin"):
        CanonicalIdentityPromotionClient(url, "secret")


def test_slow_response_cannot_extend_the_total_attempt_deadline() -> None:
    now = [0.0]

    class _TrickleResponse(_Response):
        def read(self, _limit: int) -> bytes:
            raise AssertionError("unbounded multi-recv read must not be used")

        def read1(self, _limit: int) -> bytes:
            now[0] += 1.1
            return b"x"

    _Connection.responses = [_TrickleResponse(202, {"status": "accepted"})]
    client = CanonicalIdentityPromotionClient(
        "http://backend:3006",
        "internal-test-secret",
        timeout_seconds=2,
        attempts=1,
        retry_sleep=lambda _attempt: None,
        clock=lambda: now[0],
    )

    with pytest.raises(CanonicalIdentityPromotionError) as caught:
        _submit(client)
    assert isinstance(caught.value.__cause__, TimeoutError)


def test_request_and_headers_share_the_same_attempt_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = [0.0]

    class _DelayedConnection(_Connection):
        def request(self, *args: Any, **kwargs: Any) -> None:
            super().request(*args, **kwargs)
            now[0] += 1.5

        def getresponse(self) -> _Response:
            now[0] += 0.6
            return super().getresponse()

    _DelayedConnection.responses = [_Response(202, {"status": "accepted"})]
    monkeypatch.setattr(
        canonical_identity_client.http.client,
        "HTTPConnection",
        _DelayedConnection,
    )
    client = CanonicalIdentityPromotionClient(
        "http://backend:3006",
        "internal-test-secret",
        timeout_seconds=2,
        attempts=1,
        retry_sleep=lambda _attempt: None,
        clock=lambda: now[0],
    )

    with pytest.raises(CanonicalIdentityPromotionError) as caught:
        _submit(client)
    assert isinstance(caught.value.__cause__, TimeoutError)
