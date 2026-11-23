"""Bounded direct media transport; metadata and other origins retain their route."""

import time
from types import SimpleNamespace

import pytest
import requests
from curl_cffi.curl import CURL_WRITEFUNC_ERROR
from requests.structures import CaseInsensitiveDict

URL = "https://rr1---sn-example.googlevideo.com/videoplayback?signature=private"


class CurlFailure(Exception):
    def __init__(self, code):
        super().__init__("signed-url-must-not-appear-in-public-error")
        self.code = code


class RangeOrigin:
    def __init__(self, data=b"0123456789", **changes):
        self.data = data
        self.changes = changes
        self.calls = []
        self.closed = False
        self.settings = {}

    def factory(self, **settings):
        self.settings = settings
        return self

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.changes.get("error"):
            raise CurlFailure(self.changes["error"])
        first, last = map(int, kwargs["headers"]["Range"][6:].split("-"))
        last = min(last, len(self.data) - 1)
        body = self.changes.get("body", self.data[first : last + 1])
        for offset in range(0, len(body), 2):
            if kwargs["content_callback"](body[offset : offset + 2]) == CURL_WRITEFUNC_ERROR:
                raise CurlFailure(23)
        headers = CaseInsensitiveDict(
            {
                "Content-Range": f"bytes {first}-{last}/{len(self.data)}",
                "Content-Length": str(len(body)),
                "Content-Type": "audio/webm",
                "ETag": '"same-file"',
            }
        )
        headers.update(self.changes.get("headers", {}))
        return SimpleNamespace(
            status_code=self.changes.get("status", 206),
            http_version=self.changes.get("version", 30),
            headers=headers,
            url=url,
            reason="Partial Content",
        )

    def close(self):
        self.closed = True


def client(origin, **kwargs):
    from ytmusic_http3 import Http3RangeClient

    return Http3RangeClient(session_factory=origin.factory, **kwargs)


@pytest.mark.parametrize(
    "url",
    [
        "http://rr1.googlevideo.com/a",
        "https://googlevideo.com.evil.test/a",
        "https://googlevideo.com@127.0.0.1/a",
        "https://user:password@rr1.googlevideo.com/a",
        "https://rr1.googlevideo.com:8443/a",
        "https://youtube.com/a",
        "https://manifest.googlevideo.com/api/manifest/hls_playlist/metadata",
        "https://rr1.googlevideo.com/",
    ],
)
def test_only_cdn_https_is_accepted(url):
    from ytmusic_http3 import is_media_url

    assert not is_media_url(url)


def test_direct_tls_checked_http3_range_without_streaming_queue(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://unrelated-vpn.invalid:443")
    origin = RangeOrigin()
    with client(origin) as transport:
        response = transport.get_range(URL, 2, 5, headers={}, timeout=(1, 2))
        assert response.content == b"2345"
        assert response.headers["content-range"] == "bytes 2-5/10"
    assert origin.closed
    assert origin.settings["trust_env"] is False
    assert isinstance(origin.settings["verify"], str)
    options = origin.calls[0][1]
    assert options["http_version"] == "v3only"
    assert options["allow_redirects"] is False
    assert not options.get("stream", False)


def test_large_body_aborts_at_requested_range_limit():
    origin = RangeOrigin(body=b"x" * 100)
    with client(origin) as transport, pytest.raises(requests.RequestException, match="limit"):
        transport.get_range(URL, 0, 3, headers={})


@pytest.mark.parametrize("version", [2, 3])
def test_tcp_fallback_is_not_accepted(version):
    with (
        client(RangeOrigin(version=version)) as transport,
        pytest.raises(requests.ConnectionError, match="HTTP/3"),
    ):
        transport.get_range(URL, 0, 3, headers={})


def test_cancelled_request_never_opens_network():
    origin = RangeOrigin()
    with (
        client(origin, cancel_check=lambda: True) as transport,
        pytest.raises(requests.ConnectionError, match="cancel"),
    ):
        transport.get_range(URL, 0, 3, headers={})
    assert origin.calls == []


def test_expired_deadline_never_opens_network():
    origin = RangeOrigin()
    with (
        client(origin, deadline=time.monotonic() - 1) as transport,
        pytest.raises(requests.Timeout),
    ):
        transport.get_range(URL, 0, 3, headers={})
    assert origin.calls == []


def test_cancel_during_body_aborts_transfer():
    origin = RangeOrigin()
    attempts = iter([False, False, True, True])
    with (
        client(origin, cancel_check=lambda: next(attempts, True)) as transport,
        pytest.raises(requests.ConnectionError, match="cancel"),
    ):
        transport.get_range(URL, 0, 9, headers={})


def test_redirect_cannot_escape_cdn():
    origin = RangeOrigin(status=302, body=b"", headers={"Location": "http://127.0.0.1/secrets"})
    with client(origin) as transport, pytest.raises(requests.ConnectionError, match="redirect"):
        transport.get_range(URL, 0, 3, headers={})
    assert len(origin.calls) == 1


@pytest.mark.parametrize("code,kind", [(28, requests.Timeout), (60, requests.exceptions.SSLError)])
def test_errors_keep_type_and_redact_signed_url(code, kind):
    with client(RangeOrigin(error=code)) as transport, pytest.raises(kind) as error:
        transport.get_range(URL, 0, 3, headers={})
    assert "signed-url" not in str(error.value)


def test_lazy_reader_does_not_download_tail_before_consumer_needs_it():
    from ytmusic_http3 import Http3RangeReader

    origin = RangeOrigin(b"abcdefghijkl")
    transport = client(origin)
    reader = Http3RangeReader(transport, URL, {}, timeout=2, chunk_bytes=4)
    assert reader.read(2) == b"ab"
    assert len(origin.calls) == 1
    assert reader.read(2) == b"cd"
    assert len(origin.calls) == 1
    assert reader.read(4) == b"efgh"
    assert len(origin.calls) == 2
    reader.close()
    assert origin.closed
    with pytest.raises(ValueError):
        reader.read(1)


def test_lazy_reader_rejects_changed_representation():
    from ytmusic_http3 import Http3RangeReader

    origin = RangeOrigin(b"abcdefghijkl")
    reader = Http3RangeReader(client(origin), URL, {}, timeout=2, chunk_bytes=4)
    assert reader.read(4) == b"abcd"
    origin.changes["headers"] = {"ETag": '"other-file"'}
    with pytest.raises(requests.ConnectionError, match="representation"):
        reader.read(4)
    reader.close()


def test_lazy_reader_preserves_requested_continuation():
    from ytmusic_http3 import Http3RangeReader

    origin = RangeOrigin(b"abcdefghijkl")
    with Http3RangeReader(
        client(origin), URL, {"Range": "bytes=3-8"}, timeout=2, chunk_bytes=4
    ) as reader:
        assert reader.status == 206
        assert reader.headers["Content-Range"] == "bytes 3-8/12"
        assert reader.read(6) == b"defg"
        assert reader.read(6) == b"hi"
        assert reader.read(6) == b""


def test_youtube_options_preserve_caller_and_explicit_po_client(monkeypatch):
    from ytmusic_http3 import youtube_options

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    options = {"extractor_args": {"youtube": {"player_client": ["android_vr"]}}}
    changed = youtube_options(options)
    assert changed["extractor_args"]["youtube"]["player_client"] == ["default", "-tv_samsung"]
    assert options["extractor_args"]["youtube"]["player_client"] == ["android_vr"]
    explicit = {"extractor_args": {"youtube": {"player_client": ["mweb"]}}}
    assert youtube_options(explicit) == explicit


def test_youtube_options_do_not_clone_owned_logger_or_job_resources(monkeypatch):
    import threading

    from ytmusic_http3 import youtube_options

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    logger = SimpleNamespace(lock=threading.Lock())
    assert youtube_options({"logger": logger})["logger"] is logger


def test_disabled_mode_preserves_existing_download_clients(monkeypatch):
    from ytmusic_http3 import youtube_options

    monkeypatch.delenv("YTMUSIC_CDN_HTTP3", raising=False)
    options = {"extractor_args": {"youtube": {"player_client": ["android_vr"]}}}
    assert youtube_options(options) == options


def test_media_session_keeps_metadata_on_original_transport(monkeypatch):
    from ytmusic_http3 import media_session

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    sentinel = object()
    calls = []
    monkeypatch.setattr(
        requests.Session, "get", lambda self, url, **kw: calls.append(url) or sentinel
    )
    with media_session() as session:
        assert session.get("https://www.youtube.com/watch?v=metadata") is sentinel
    assert calls == ["https://www.youtube.com/watch?v=metadata"]


@pytest.mark.parametrize("url", ["https://www.youtube.com/watch", b"https://www.youtube.com/watch"])
def test_media_session_preserves_positional_metadata_params(monkeypatch, url):
    from ytmusic_http3 import media_session

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    calls = []
    sentinel = object()

    def original_get(self, url, params=None, **kwargs):
        calls.append((url, params, kwargs))
        return sentinel

    monkeypatch.setattr(requests.Session, "get", original_get)
    with media_session() as session:
        assert session.get(url, {"v": "metadata"}, timeout=2) is sentinel
    assert calls == [(url, {"v": "metadata"}, {"timeout": 2})]


def test_media_session_encodes_positional_params_without_losing_signed_query(monkeypatch):
    import ytmusic_http3

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    origin = RangeOrigin()
    transport = client(origin)
    monkeypatch.setattr(ytmusic_http3, "Http3RangeClient", lambda **_options: transport)
    with ytmusic_http3.media_session() as session:
        response = session.get(URL, {"extra": "two words"}, headers={"Range": "bytes=0-3"})
        assert response.content == b"0123"
    assert origin.calls[0][0] == URL + "&extra=two+words"
    assert origin.closed


def test_ytdlp_handler_is_explicit_and_scoped(monkeypatch):
    from yt_dlp.networking.common import Request
    from yt_dlp.networking.exceptions import UnsupportedRequest
    from ytmusic_http3 import youtube_dl

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    options = {"quiet": True, "extractor_args": {"youtube": {"player_client": ["android_vr"]}}}
    with youtube_dl(options) as downloader:
        handler = downloader._request_director.handlers["GoogleVideoHttp3"]
        handler.validate(Request(URL, proxies={"https": "http://unrelated-vpn.invalid"}))
        with pytest.raises(UnsupportedRequest):
            handler.validate(Request("https://youtube.com/watch?v=metadata"))
        assert downloader.params["extractor_args"]["youtube"]["player_client"] == [
            "default",
            "-tv_samsung",
        ]
    assert options["extractor_args"]["youtube"]["player_client"] == ["android_vr"]


def test_ytdlp_handler_reads_lazily_through_http3(monkeypatch):
    import ytmusic_http3_ytdlp as handler_module
    from yt_dlp.networking.common import Request
    from ytmusic_http3 import youtube_dl

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    origin = RangeOrigin(b"abcdefghijkl")
    monkeypatch.setattr(
        handler_module, "Http3RangeClient", lambda **kwargs: client(origin, **kwargs)
    )
    with youtube_dl({"quiet": True}) as downloader, downloader.urlopen(Request(URL)) as response:
        assert response.status == 200
        assert response.headers["Content-Length"] == "12"
        assert response.read(4) == b"abcd"
        assert response.read(20) == b"efghijkl"
        assert response.read(1) == b""
    assert origin.closed


def test_extraction_timing_never_logs_signed_url(monkeypatch, caplog):
    import yt_dlp
    from ytmusic_http3 import youtube_dl

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    monkeypatch.setattr(yt_dlp.YoutubeDL, "extract_info", lambda *_a, **_k: {"id": "video"})
    with caplog.at_level("INFO", logger="ytmusic_http3"), youtube_dl({"quiet": True}) as downloader:
        assert downloader.extract_info(URL, download=False) == {"id": "video"}
    assert "duration_ms=" in caplog.text
    assert "download=False" in caplog.text
    assert "signature" not in caplog.text


def test_metadata_mode_is_separate_and_preserves_real_metadata(monkeypatch):
    from yt_dlp.networking.common import Request
    from yt_dlp.networking.exceptions import UnsupportedRequest
    from ytmusic_http3 import youtube_dl

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    monkeypatch.setenv("YTMUSIC_METADATA_HTTP3", "1")
    with youtube_dl({"quiet": True}) as downloader:
        handler = downloader._request_director.handlers["YouTubeMetadataHttp3"]
        handler.validate(Request("https://www.youtube.com/watch?v=video"))
        with pytest.raises(UnsupportedRequest):
            handler.validate(Request("https://example.org/watch?v=video"))
        with pytest.raises(UnsupportedRequest):
            handler.validate(Request("https://www.youtube.com/redirect?q=https://example.org"))
        assert "player_skip" not in downloader.params.get("extractor_args", {}).get("youtube", {})


def test_metadata_session_is_closed_when_its_downloader_exits(monkeypatch):
    from ytmusic_http3 import youtube_dl

    monkeypatch.setenv("YTMUSIC_CDN_HTTP3", "1")
    monkeypatch.setenv("YTMUSIC_METADATA_HTTP3", "1")
    with youtube_dl({"quiet": True}) as downloader:
        handler = downloader._request_director.handlers["YouTubeMetadataHttp3"]
        session = handler._get_instance(cookiejar=None)
        assert not session._closed
    assert session._closed


def test_metadata_transport_has_no_background_producer(monkeypatch):
    from types import SimpleNamespace

    from curl_cffi import Session
    from ytmusic_http3_ytdlp import BoundedMetadataSession

    calls = []

    def serve(self, *args, **kwargs):
        calls.append(kwargs)
        assert kwargs["content_callback"](b"<html>visitor data</html>") > 0
        return SimpleNamespace(content=b"", http_version=30, status_code=200, close=lambda: None)

    monkeypatch.setattr(Session, "request", serve)
    with BoundedMetadataSession() as session:
        result = session.get("https://www.youtube.com/watch?v=video", stream=True, timeout=(20, 20))
        assert b"".join(result.iter_content()) == b"<html>visitor data</html>"
    assert calls[0]["stream"] is False
    assert sum(calls[0]["timeout"]) <= 11


def test_metadata_body_limit_aborts_before_excess_is_retained(monkeypatch):
    import ytmusic_http3_ytdlp as handler
    from curl_cffi import Session
    from curl_cffi.requests.exceptions import RequestException
    from ytmusic_http3_ytdlp import BoundedMetadataSession

    monkeypatch.setattr(handler, "MAX_METADATA_BYTES", 4)

    def serve(self, *args, **kwargs):
        assert kwargs["content_callback"](b"abcd") == 4
        assert kwargs["content_callback"](b"e") == CURL_WRITEFUNC_ERROR
        raise RequestException("internal URL", code=23)

    monkeypatch.setattr(Session, "request", serve)
    with BoundedMetadataSession() as session, pytest.raises(RequestException, match="limit"):
        session.get("https://www.youtube.com/watch?v=video", stream=True)


def test_metadata_cannot_silently_use_tcp(monkeypatch):
    from curl_cffi import Session
    from curl_cffi.requests.exceptions import RequestException
    from ytmusic_http3_ytdlp import BoundedMetadataSession

    closed = []
    monkeypatch.setattr(
        Session,
        "request",
        lambda *_a, **_k: SimpleNamespace(
            content=b"", http_version=3, close=lambda: closed.append(True)
        ),
    )
    with BoundedMetadataSession() as session, pytest.raises(RequestException, match="HTTP/3"):
        session.get("https://www.youtube.com/watch?v=video")
    assert closed == [True]


@pytest.mark.parametrize("kind", ["media", "metadata"])
def test_real_curl_stops_reading_at_the_body_limit(monkeypatch, kind):
    """The binding ignores return 0; exercise its actual C write callback."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from curl_cffi import Session
    from ytmusic_http3 import Http3RangeClient

    callbacks = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(1024 * 1024))
            self.end_headers()
            try:
                self.wfile.write(b"x" * (1024 * 1024))
            except (BrokenPipeError, ConnectionResetError):
                # The expected client abort can close the server's socket early.
                return

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()

    class WireSession:
        def __init__(self, **kwargs):
            self.inner = Session(**kwargs)

        def get(self, _url, **kwargs):
            original = kwargs["content_callback"]

            def receive(chunk):
                callbacks.append(len(chunk))
                return original(chunk)

            kwargs.update(content_callback=receive, http_version="v1")
            return self.inner.get(f"http://127.0.0.1:{server.server_port}/", **kwargs)

        def close(self):
            self.inner.close()

    try:
        if kind == "media":
            with (
                Http3RangeClient(session_factory=WireSession) as transport,
                pytest.raises(requests.ConnectionError, match="limit"),
            ):
                transport.get_range(URL, 0, 3, headers={})
        else:
            import ytmusic_http3_ytdlp as handler
            from curl_cffi.requests.exceptions import RequestException

            original_request = Session.request

            def monitored(session, *args, **kwargs):
                original = kwargs["content_callback"]

                def receive(chunk):
                    callbacks.append(len(chunk))
                    return original(chunk)

                kwargs["content_callback"] = receive
                return original_request(session, *args, **kwargs)

            monkeypatch.setattr(handler, "MAX_METADATA_BYTES", 4)
            monkeypatch.setattr(Session, "request", monitored)
            with (
                handler.BoundedMetadataSession(trust_env=False) as session,
                pytest.raises(RequestException, match="limit"),
            ):
                session.get(f"http://127.0.0.1:{server.server_port}/", http_version="v1")
        assert len(callbacks) == 1
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
