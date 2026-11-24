"""Public ytmusicapi transport selection, safety bounds and session ownership."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from typing import Any

import certifi
import pytest
import requests
from curl_cffi import Session
from curl_cffi.requests.exceptions import RequestException


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Drive the real metadata callback while preventing accidental TCP traffic."""
    monkeypatch.setenv("YTMUSIC_METADATA_HTTP3", "1")
    calls: list[dict[str, Any]] = []

    def reject_tcp(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("public request stayed on the TCP transport")

    def serve(session: Any, method: str, url: str, **kwargs: Any) -> Any:
        calls.append({"session": session, "method": method, "url": url, **kwargs})
        payload = (
            b'ytcfg.set({"VISITOR_DATA":"anonymous-test-context"});'
            if method.upper() == "GET"
            else b'{"result":"public-catalog"}'
        )
        assert kwargs["content_callback"](payload) == len(payload)
        return SimpleNamespace(
            http_version=30,
            status_code=200,
            headers={"Content-Type": "application/json; charset=utf-8"},
            reason="OK",
            url=url,
            content=b"",
            close=lambda: None,
        )

    monkeypatch.setattr(requests.Session, "send", reject_tcp)
    monkeypatch.setattr(Session, "request", serve)
    return calls


@pytest.mark.parametrize("endpoint", ["next", "search"])
def test_public_client_uses_verified_bounded_http3_for_bootstrap_and_api(
    wire: list[dict[str, Any]], endpoint: str
) -> None:
    """A real YTMusic instance must retain and use the custom requests Session."""
    import ytmusic_client as client

    yt = client._create_public_ytmusic("native", 5.0)
    owned = vars(yt)[client._SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE]
    try:
        assert yt._session is owned
        assert isinstance(owned, requests.Session)
        assert yt._send_request(endpoint, {"query": "test"}) == {"result": "public-catalog"}
    finally:
        client._close_owned_ytmusic_session(yt)

    assert [call["method"] for call in wire] == ["GET", "POST"]
    assert wire[-1]["url"].startswith(f"https://music.youtube.com/youtubei/v1/{endpoint}?")
    assert json.loads(wire[-1]["data"])["query"] == "test"
    for call in wire:
        assert call["http_version"] == "v3only"
        assert call["allow_redirects"] is False
        assert call["stream"] is False
        assert 0 < sum(call["timeout"]) <= 5.0
        assert call["session"].trust_env is False
        assert call["session"].verify == certifi.where()
        assert call["session"]._use_thread_local_curl is False
        assert call["session"]._closed is True


@pytest.mark.parametrize(
    ("method", "url"),
    [
        ("GET", "https://example.org/"),
        ("GET", "https://music.youtube.com.evil.test/"),
        ("GET", "https://user:password@music.youtube.com/"),
        ("GET", "https://music.youtube.com:444/"),
        ("GET", "http://music.youtube.com/"),
        ("GET", "https://music.youtube.com/redirect"),
        ("GET", "https://music.youtube.com/youtubei/v1/search"),
        ("POST", "https://music.youtube.com/"),
        ("DELETE", "https://music.youtube.com/youtubei/v1/browse"),
        ("POST", "https://music.youtube.com/youtubei/v1/like/like"),
        ("POST", "https://music.youtube.com/youtubei/v1/playlist/create"),
    ],
)
def test_public_transport_rejects_unapproved_origins_methods_and_private_apis(
    wire: list[dict[str, Any]], method: str, url: str
) -> None:
    import ytmusic_client as client

    yt = client._create_public_ytmusic("native", 5.0)
    try:
        with pytest.raises(requests.RequestException):
            yt._session.request(method, url)
    finally:
        client._close_owned_ytmusic_session(yt)
    assert wire == []


@pytest.mark.parametrize(
    "headers",
    [
        {"Authorization": "private"},
        {"Proxy-Authorization": "private"},
        {"Cookie": "SID=private"},
        {"Cookie": 'SID="unfinished'},
        {"Cookie": 'SOCS=CAI; SID="unfinished'},
    ],
)
def test_public_transport_rejects_account_credentials(
    wire: list[dict[str, Any]], headers: dict[str, str]
) -> None:
    import ytmusic_client as client

    yt = client._create_public_ytmusic("native", 5.0)
    try:
        with pytest.raises(requests.RequestException):
            yt._session.get("https://music.youtube.com/", headers=headers)
    finally:
        client._close_owned_ytmusic_session(yt)
    assert wire == []


@pytest.mark.parametrize(
    ("code", "expected"),
    [(28, requests.Timeout), (60, requests.exceptions.SSLError), (7, requests.ConnectionError)],
)
def test_public_transport_maps_sanitized_requests_errors(
    wire: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    code: int,
    expected: type[Exception],
) -> None:
    import ytmusic_client as client

    def fail(*_args: Any, **_kwargs: Any) -> Any:
        raise RequestException("private URL and proxy credential", code=code)

    monkeypatch.setattr(Session, "request", fail)
    yt = client._create_public_ytmusic("native", 5.0)
    try:
        with pytest.raises(expected) as caught:
            yt._session.get("https://music.youtube.com/")
    finally:
        client._close_owned_ytmusic_session(yt)
    assert "private" not in str(caught.value)
    assert "credential" not in str(caught.value)
    assert caught.value.__cause__ is None


def test_public_transport_aborts_oversized_responses_before_buffering_excess(
    wire: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    import ytmusic_client as client
    import ytmusic_http3_ytdlp as metadata
    from ytmusic_http3 import CURL_WRITEFUNC_ERROR

    monkeypatch.setattr(metadata, "MAX_METADATA_BYTES", 4)
    callbacks: list[int] = []

    def oversized(*_args: Any, **kwargs: Any) -> Any:
        callbacks.append(kwargs["content_callback"](b"abcd"))
        callbacks.append(kwargs["content_callback"](b"e"))
        raise RequestException("private upstream URL", code=23)

    monkeypatch.setattr(Session, "request", oversized)
    yt = client._create_public_ytmusic("native", 5.0)
    try:
        with pytest.raises(requests.ConnectionError):
            yt._session.get("https://music.youtube.com/")
    finally:
        client._close_owned_ytmusic_session(yt)
    assert callbacks == [4, CURL_WRITEFUNC_ERROR]


@pytest.mark.parametrize("status", [302, 403, 503])
def test_public_transport_does_not_follow_redirects_or_mask_upstream_status(
    wire: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    import ytmusic_client as client

    def serve(*_args: Any, **kwargs: Any) -> Any:
        assert kwargs["allow_redirects"] is False
        assert kwargs["content_callback"](b"{}") == 2
        return SimpleNamespace(
            http_version=30,
            status_code=status,
            headers={"Location": "https://example.org/"},
            reason="Upstream status",
            url="https://music.youtube.com/",
            content=b"",
            close=lambda: None,
        )

    monkeypatch.setattr(Session, "request", serve)
    yt = client._create_public_ytmusic("native", 5.0)
    try:
        if status == 302:
            with pytest.raises(requests.ConnectionError, match="redirect"):
                yt._session.get("https://music.youtube.com/")
        else:
            assert yt._session.get("https://music.youtube.com/").status_code == status
    finally:
        client._close_owned_ytmusic_session(yt)


def test_public_session_owns_one_handle_across_sequential_worker_threads(
    wire: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    import ytmusic_client as client

    yt = client._create_public_ytmusic("native", 5.0)
    handles: list[Any] = []
    try:
        for _ in range(2):
            with ThreadPoolExecutor(max_workers=1) as executor:
                executor.submit(yt._session.get, "https://music.youtube.com/").result(timeout=2)
            handles.append(wire[-1]["session"].curl)
        assert handles[0] is handles[1]
        close_calls: list[bool] = []
        original_close = handles[0].close

        def close() -> None:
            close_calls.append(True)
            original_close()

        monkeypatch.setattr(handles[0], "close", close)
        client._close_owned_ytmusic_session(yt)
        client._close_owned_ytmusic_session(yt)
        assert close_calls == [True]
    finally:
        client._close_owned_ytmusic_session(yt)


def test_private_session_builder_keeps_its_requests_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ytmusic_client as client

    monkeypatch.setenv("YTMUSIC_METADATA_HTTP3", "1")
    with client._build_ytmusic_requests_session() as session:
        assert type(session) is requests.Session
        assert session.trust_env is True


def test_public_transport_flag_off_preserves_the_standard_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ytmusic_client as client

    monkeypatch.delenv("YTMUSIC_METADATA_HTTP3", raising=False)
    yt = client._create_public_ytmusic("native", 5.0)
    try:
        assert type(yt._session) is requests.Session
    finally:
        client._close_owned_ytmusic_session(yt)
