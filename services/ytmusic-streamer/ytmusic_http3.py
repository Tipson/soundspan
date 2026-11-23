"""Opt-in, bounded HTTP/3 reads for signed GoogleVideo media, never metadata.

Ranges are consumed synchronously on the existing download worker. No curl
streaming queue or additional transfer thread can grow behind a slow reader.
"""

from __future__ import annotations

import copy
import io
import logging
import os
import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urljoin, urlsplit

import certifi
import requests
from requests.structures import CaseInsensitiveDict

log = logging.getLogger(__name__)
MAX_RANGE_BYTES = 1024 * 1024
FIRST_RANGE_BYTES = 64 * 1024
# curl_cffi's callback adapter ignores 0; libcurl's explicit abort sentinel is required.
CURL_WRITEFUNC_ERROR = 0xFFFFFFFF


def enabled() -> bool:
    """Return whether this sidecar explicitly selected direct CDN HTTP/3."""
    return os.getenv("YTMUSIC_CDN_HTTP3", "").strip().lower() in {"1", "true", "yes"}


def direct_curl_options() -> dict[Any, Any]:
    """Keep optional DoH inside this client instead of changing host DNS."""
    from curl_cffi import CurlOpt

    result: dict[Any, Any] = {CurlOpt.IPRESOLVE: 1}
    doh = os.getenv("YTMUSIC_HTTP3_DOH_URL", "").strip()
    if doh:
        parsed = urlsplit(doh)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None:
            raise ValueError("HTTP3 DoH must use HTTPS without URL credentials")
        result.update(
            {
                CurlOpt.DOH_URL: doh,
                CurlOpt.DOH_SSL_VERIFYPEER: 1,
                CurlOpt.DOH_SSL_VERIFYHOST: 2,
            }
        )
    return result


def is_media_url(url: str) -> bool:
    """Allow only credential-free HTTPS GoogleVideo origins on their normal port."""
    try:
        parsed = urlsplit(url)
        return (
            parsed.scheme == "https"
            and (parsed.hostname or "").endswith(".googlevideo.com")
            and (parsed.path == "/videoplayback" or parsed.path.startswith("/videoplayback/"))
            and parsed.port in (None, 443)
            and parsed.username is None
        )
    except ValueError:
        return False


class Http3RangeClient:
    """Own one reusable QUIC client and enforce a bounded byte-range response."""

    def __init__(
        self,
        *,
        cancel_check: Callable[[], bool] = lambda: False,
        deadline: float | None = None,
        session_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.cancel_check = cancel_check
        self.deadline = deadline
        options: dict[str, Any] = {"trust_env": False, "verify": certifi.where()}
        if session_factory is None:
            from curl_cffi import Session

            session_factory = Session
            options["curl_options"] = direct_curl_options()
        self.session = session_factory(**options)

    def __enter__(self) -> Http3RangeClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def close(self) -> None:
        """Release the easy handle on the thread which owns this transfer."""
        self.session.close()

    def _check(self, deadline: float) -> None:
        if self.cancel_check():
            raise requests.ConnectionError("HTTP3 media transfer cancelled")
        if time.monotonic() >= min(deadline, self.deadline or float("inf")):
            raise requests.Timeout("HTTP3 media transfer deadline exceeded")

    def get_range(
        self,
        url: str,
        first: int,
        last: int,
        *,
        headers: dict[str, str],
        timeout: tuple[float, float] = (3, 5),
    ) -> requests.Response:
        """Fetch at most one MiB, aborting before an excess body is retained."""
        limit = last - first + 1
        if first < 0 or not 0 < limit <= MAX_RANGE_BYTES or not is_media_url(url):
            raise requests.ConnectionError("Invalid HTTP3 media range or origin")
        started = time.monotonic()
        deadline = min(started + sum(timeout), self.deadline or float("inf"))
        request_headers = CaseInsensitiveDict(headers)
        request_headers.update({"Range": f"bytes={first}-{last}", "Accept-Encoding": "identity"})
        for _redirect in range(4):
            self._check(deadline)
            body = bytearray()
            aborted: list[requests.RequestException] = []

            def receive(
                chunk: bytes,
                buffer: bytearray = body,
                errors: list[requests.RequestException] = aborted,
            ) -> int:
                if errors:
                    return CURL_WRITEFUNC_ERROR
                try:
                    self._check(deadline)
                    if len(buffer) + len(chunk) > limit:
                        raise requests.ConnectionError("HTTP3 media response exceeded range limit")
                    buffer.extend(chunk)
                    return len(chunk)
                except requests.RequestException as error:
                    errors.append(error)
                    return CURL_WRITEFUNC_ERROR

            remaining = deadline - time.monotonic()
            connect = min(timeout[0], remaining / 2)
            try:
                result = self.session.get(
                    url,
                    headers=dict(request_headers),
                    http_version="v3only",
                    allow_redirects=False,
                    accept_encoding="identity",
                    timeout=(connect, remaining - connect),
                    content_callback=receive,
                )
            except Exception as error:
                if aborted:
                    raise aborted[0] from None
                code = int(getattr(error, "code", 0))
                error_type = {28: requests.Timeout, 60: requests.exceptions.SSLError}.get(
                    code, requests.ConnectionError
                )
                # Signed URLs and proxy credentials can appear in curl's error string.
                raise error_type(f"HTTP3 media transport failed (code {code})") from None
            if aborted:
                raise aborted[0]
            if int(result.http_version) != 30:
                raise requests.ConnectionError("Media response did not use HTTP/3")
            response = requests.Response()
            response.status_code = result.status_code
            response.headers = CaseInsensitiveDict(result.headers.items())
            response.url = result.url
            response.reason = result.reason
            response._content = bytes(body)
            response._content_consumed = True
            if response.status_code in {301, 302, 303, 307, 308}:
                destination = urljoin(url, response.headers.get("Location", ""))
                if not is_media_url(destination) or destination == url:
                    raise requests.ConnectionError("Untrusted HTTP3 media redirect")
                url = destination
                continue
            if response.status_code in {200, 206}:
                self._validate(response, first, last)
            if first == 0:
                log.info(
                    "HTTP3 media prefix received: status=%d bytes=%d duration_ms=%d",
                    response.status_code,
                    len(body),
                    int((time.monotonic() - started) * 1000),
                )
            return response
        raise requests.ConnectionError("HTTP3 media redirect limit exceeded")

    @staticmethod
    def _validate(response: requests.Response, first: int, last: int) -> None:
        if response.headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
            raise requests.ConnectionError("Unexpected HTTP3 media content encoding")
        length = response.headers.get("Content-Length")
        if length is not None and (not length.isdigit() or int(length) != len(response.content)):
            raise requests.ConnectionError("Incomplete HTTP3 media response")
        if response.status_code == 200:
            if first != 0:
                raise requests.ConnectionError("HTTP3 media ignored a continuation range")
            return
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
        if match is None:
            raise requests.ConnectionError("Invalid HTTP3 media content range")
        begin, end, total = map(int, match.groups())
        if (
            begin != first
            or end != min(last, total - 1)
            or len(response.content) != end - begin + 1
        ):
            raise requests.ConnectionError("HTTP3 media skipped or truncated a byte range")


def _requested_range(headers: dict[str, str]) -> tuple[int, int | None]:
    value = CaseInsensitiveDict(headers).get("Range")
    if value is None:
        return 0, None
    match = re.fullmatch(r"bytes=(\d+)-(\d*)", value)
    if match is None:
        raise requests.ConnectionError("Unsupported HTTP3 media range")
    start, end = int(match[1]), int(match[2]) if match[2] else None
    if end is not None and end < start:
        raise requests.ConnectionError("Invalid HTTP3 media range")
    return start, end


class Http3RangeReader(io.RawIOBase):
    """Provide yt-dlp a lazy response, reading no tail before its next read call."""

    def __init__(
        self,
        client: Http3RangeClient,
        url: str,
        headers: dict[str, str],
        *,
        timeout: float,
        chunk_bytes: int = MAX_RANGE_BYTES,
    ) -> None:
        super().__init__()
        self.client, self.url, self.request_headers = client, url, headers
        self.timeout = (min(3, timeout), timeout)
        self.chunk_bytes = min(chunk_bytes, MAX_RANGE_BYTES)
        self.position, self.requested_end = _requested_range(headers)
        self.buffer = b""
        self.total: int | None = None
        self.validator: str | None = None
        self.headers: CaseInsensitiveDict[str] = CaseInsensitiveDict()
        self.status = 206 if "Range" in CaseInsensitiveDict(headers) else 200
        try:
            self._fill(min(self.chunk_bytes, FIRST_RANGE_BYTES))
            self.headers["Content-Length"] = str(self.end - self.position + 1)
            if self.status == 206:
                self.headers["Content-Range"] = f"bytes {self.position}-{self.end}/{self.total}"
            else:
                self.headers.pop("Content-Range", None)
        except Exception:
            self.close()
            raise

    def _fill(self, count: int) -> None:
        last = self.position + count - 1
        if self.requested_end is not None:
            last = min(last, self.requested_end)
        headers = dict(self.request_headers)
        if self.validator:
            headers["If-Range"] = self.validator
        response = self.client.get_range(
            self.url, self.position, last, headers=headers, timeout=self.timeout
        )
        response.raise_for_status()
        if response.status_code == 206:
            total = int(response.headers["Content-Range"].rsplit("/", 1)[1])
        else:
            total = len(response.content)
        if self.total is not None and (
            total != self.total
            or (self.validator and response.headers.get("ETag") != self.validator)
        ):
            raise requests.ConnectionError("HTTP3 media changed its representation")
        self.total = total
        self.end = min(
            self.requested_end if self.requested_end is not None else total - 1, total - 1
        )
        if not self.headers:
            self.headers.update(response.headers)
            etag = response.headers.get("ETag")
            self.validator = etag if etag and not etag.startswith("W/") else None
        self.url = response.url
        self.buffer = response.content

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:
        """Return a bounded short read; the media downloader must specify its size."""
        if self.closed:
            raise ValueError("I/O operation on closed media response")
        if size < 0:
            raise ValueError("Unbounded reads are not supported for HTTP3 media")
        if size == 0 or self.position > self.end:
            return b""
        if not self.buffer:
            self._fill(min(self.chunk_bytes, self.end - self.position + 1))
        chunk, self.buffer = self.buffer[:size], self.buffer[size:]
        self.position += len(chunk)
        return chunk

    def close(self) -> None:
        if not self.closed:
            self.buffer = b""
            self.client.close()
        super().close()


def youtube_options(options: dict[str, Any]) -> dict[str, Any]:
    """Use a proven progressive client for this explicit HTTP3 route only."""
    if not enabled():
        return options
    result = dict(options)
    if "extractor_args" in options:
        result["extractor_args"] = copy.deepcopy(options["extractor_args"])
    youtube = result.get("extractor_args", {}).get("youtube", {})
    if youtube.get("player_client") == ["android_vr"]:
        youtube["player_client"] = ["default", "-tv_samsung"]
    return result


class _MediaSession(requests.Session):
    """Keep metadata on requests and own one reusable direct CDN client."""

    def __init__(self, **options: Any) -> None:
        super().__init__()
        self._http3 = Http3RangeClient(**options)

    def get(self, url: str | bytes, params: Any = None, **kwargs: Any) -> requests.Response:
        if not isinstance(url, str) or not is_media_url(url):
            return super().get(url, params=params, **kwargs)
        if params is not None:
            url = requests.Request("GET", url, params=params).prepare().url or url
        headers = kwargs.get("headers", {})
        first, last = _requested_range(headers)
        if last is None:
            raise requests.ConnectionError("HTTP3 spool requests must specify a bounded range")
        return self._http3.get_range(
            url, first, last, headers=headers, timeout=kwargs.get("timeout", (3, 5))
        )

    def close(self) -> None:
        self._http3.close()
        super().close()


def media_session(**options: Any) -> requests.Session:
    """Build a transfer-owned client without changing the requests module."""
    return _MediaSession(**options) if enabled() else requests.Session()


def youtube_dl(options: dict[str, Any], *, cancel_check: Callable[[], bool] = lambda: False) -> Any:
    """Build an isolated yt-dlp instance with a direct media-only handler."""
    import yt_dlp

    if not enabled():
        return yt_dlp.YoutubeDL(options)
    from ytmusic_http3_ytdlp import GoogleVideoHttp3RH, YouTubeMetadataHttp3RH

    class MediaYoutubeDL(yt_dlp.YoutubeDL):  # type: ignore[misc,no-any-unimported]  # Upstream is untyped.
        def extract_info(self, *args: Any, **kwargs: Any) -> Any:
            started = time.monotonic()
            succeeded = False
            try:
                result = super().extract_info(*args, **kwargs)
                succeeded = True
                return result
            finally:
                log.info(
                    "YouTube extraction finished: download=%s success=%s duration_ms=%d",
                    kwargs.get("download", args[1] if len(args) > 1 else True),
                    succeeded,
                    int((time.monotonic() - started) * 1000),
                )

        def build_request_director(self, handlers: Any, preferences: Any = None) -> Any:
            director = super().build_request_director(handlers, preferences)
            director.add_handler(
                GoogleVideoHttp3RH(
                    logger=director.logger,
                    headers=self.params["http_headers"],
                    cookiejar=self.cookiejar,
                    timeout=self.params.get("socket_timeout"),
                    verify=True,
                    cancel_check=cancel_check,
                )
            )
            director.preferences.add(
                lambda handler, _request: 1000 if isinstance(handler, GoogleVideoHttp3RH) else 0
            )
            if os.getenv("YTMUSIC_METADATA_HTTP3", "").strip().lower() in {"1", "true", "yes"}:
                director.add_handler(
                    YouTubeMetadataHttp3RH(
                        logger=director.logger,
                        headers=self.params["http_headers"],
                        cookiejar=self.cookiejar,
                        timeout=self.params.get("socket_timeout"),
                        verify=True,
                    )
                )
                director.preferences.add(
                    lambda handler, _request: (
                        1000 if isinstance(handler, YouTubeMetadataHttp3RH) else 0
                    )
                )
            return director

    return MediaYoutubeDL(youtube_options(options))
