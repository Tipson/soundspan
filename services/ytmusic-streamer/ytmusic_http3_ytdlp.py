"""Explicit yt-dlp RequestHandler for the opt-in direct GoogleVideo transport."""

from __future__ import annotations

import io
import logging
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit
from weakref import WeakSet

import certifi
import requests
from curl_cffi import CurlOpt, Session
from curl_cffi.requests.exceptions import RequestException
from yt_dlp.networking._curlcffi import CurlCFFIRH
from yt_dlp.networking.common import Request, RequestHandler, Response
from yt_dlp.networking.exceptions import (
    CertificateVerifyError,
    HTTPError,
    TransportError,
    UnsupportedRequest,
)
from ytmusic_http3 import (
    CURL_WRITEFUNC_ERROR,
    Http3RangeClient,
    Http3RangeReader,
    direct_curl_options,
    is_media_url,
)

MAX_METADATA_BYTES = 8 * 1024 * 1024
log = logging.getLogger(__name__)


class _BufferedMetadataResponse:
    """Expose curl's response protocol over an already bounded, synchronous body."""

    def __init__(self, response: Any) -> None:
        self.response = response

    def __getattr__(self, name: str) -> Any:
        return getattr(self.response, name)

    def iter_content(self, chunk_size: int | None = None, **_kwargs: Any) -> Any:
        size = chunk_size or 64 * 1024
        for offset in range(0, len(self.response.content), size):
            yield self.response.content[offset : offset + size]


class BoundedMetadataSession(Session):
    """Use the official yt-dlp adapter without curl's background streaming queue."""

    def request(self, *args: Any, **kwargs: Any) -> Any:
        started = time.monotonic()
        body = bytearray()
        exceeded = False

        def receive(chunk: bytes) -> int:
            nonlocal exceeded
            if len(body) + len(chunk) > MAX_METADATA_BYTES:
                exceeded = True
                return CURL_WRITEFUNC_ERROR
            body.extend(chunk)
            return len(chunk)

        timeout = kwargs.get("timeout")
        if isinstance(timeout, (tuple, list)):
            connect, read = timeout
        elif isinstance(timeout, (int, float)):
            connect = read = timeout
        else:
            connect, read = 3, 8
        kwargs.update(
            stream=False,
            timeout=(min(connect, 3), min(read, 8)),
            content_callback=receive,
        )
        try:
            response = super().request(*args, **kwargs)
        except RequestException:
            if exceeded:
                raise RequestException(
                    "HTTP3 metadata response exceeded body limit", code=63
                ) from None
            raise
        if int(response.http_version) != 30:
            response.close()
            raise RequestException("Metadata response did not use HTTP/3", code=95)
        response.content = bytes(body)
        log.info(
            "HTTP3 metadata received: status=%d bytes=%d duration_ms=%d",
            response.status_code,
            len(body),
            int((time.monotonic() - started) * 1000),
        )
        return _BufferedMetadataResponse(response)


class YouTubeMetadataHttp3RH(CurlCFFIRH):
    """Opt-in QUIC for extraction pages, player API and fixed YouTube assets."""

    def _check_url_scheme(self, request: Request) -> str:
        parsed = urlsplit(request.url)
        host = parsed.hostname or ""
        asset = host in {"i.ytimg.com", "s.ytimg.com"}
        api = host == "youtubei.googleapis.com" and parsed.path.startswith("/youtubei/")
        page = host in {"www.youtube.com", "music.youtube.com"} and (
            parsed.path == "/watch" or parsed.path.startswith(("/youtubei/", "/s/player/"))
        )
        if (
            parsed.scheme != "https"
            or parsed.port not in (None, 443)
            or parsed.username is not None
            or request.method not in {"GET", "POST"}
            or not (asset or api or page)
        ):
            raise UnsupportedRequest("Direct metadata HTTP3 accepts only fixed YouTube endpoints")
        return "https"

    def _get_proxies(self, _request: Request) -> dict[str, str]:
        return {}

    def close(self) -> None:
        """Release cached metadata handles on downloader exit, not eventual GC."""
        self._clear_instances()

    def _create_instance(self, cookiejar: Any = None) -> BoundedMetadataSession:
        options = direct_curl_options()
        options.update(
            {CurlOpt.MAXFILESIZE_LARGE: MAX_METADATA_BYTES, CurlOpt.REDIR_PROTOCOLS_STR: "https"}
        )
        return BoundedMetadataSession(
            cookies=cookiejar,
            trust_env=False,
            verify=certifi.where(),
            http_version="v3only",
            curl_options=options,
        )


class GoogleVideoHttp3RH(RequestHandler):
    """Own media readers; all metadata falls through to yt-dlp's usual handlers."""

    _SUPPORTED_URL_SCHEMES = ("https",)

    def __init__(self, *, cancel_check: Callable[[], bool], **options: Any) -> None:
        super().__init__(**options)
        self.cancel_check = cancel_check
        self._readers: WeakSet[Http3RangeReader] = WeakSet()

    def _check_url_scheme(self, request: Request) -> str:
        if request.method != "GET" or not is_media_url(request.url):
            raise UnsupportedRequest("Direct HTTP3 accepts only HTTPS GoogleVideo media GETs")
        return "https"

    def _check_proxies(self, _proxies: Any) -> None:
        """The explicitly selected direct CDN route intentionally ignores proxies."""
        super()._check_proxies({})

    def _send(self, request: Request) -> Response:
        client = Http3RangeClient(cancel_check=self.cancel_check)
        try:
            reader = Http3RangeReader(
                client,
                request.url,
                self._get_headers(request),
                timeout=self._calculate_timeout(request),
            )
        except requests.HTTPError as error:
            upstream = error.response
            if upstream is None:
                raise TransportError("HTTP3 media returned an invalid HTTP error") from None
            raise HTTPError(
                Response(
                    io.BytesIO(upstream.content),
                    upstream.url,
                    upstream.headers,
                    status=upstream.status_code,
                )
            ) from None
        except requests.exceptions.SSLError as error:
            raise CertificateVerifyError(cause=error) from None
        except requests.RequestException as error:
            raise TransportError(cause=error) from None
        self._readers.add(reader)
        return Response(
            reader,
            reader.url,
            reader.headers,
            status=reader.status,
            extensions={"http_version": "HTTP/3"},
        )

    def close(self) -> None:
        """Release abandoned readers before the owning downloader exits."""
        for reader in list(self._readers):
            reader.close()
        self._readers.clear()
