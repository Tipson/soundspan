"""Opt-in HTTP/3 for public ytmusicapi reads through its supported Session seam.

The owning public-client lease serializes use and closes this session only after
its worker finishes. One curl handle can therefore move between worker threads
without creating thread-local handles which retirement could leave unclosed.
"""

from __future__ import annotations

import math
from http.cookies import CookieError, SimpleCookie
from typing import Any
from urllib.parse import urlsplit

import certifi
import requests
from curl_cffi.requests.exceptions import RequestException
from ytmusic_http3 import direct_curl_options
from ytmusic_http3_ytdlp import BoundedMetadataSession

_PUBLIC_POST_PATHS = frozenset(
    f"/youtubei/v1/{endpoint}"
    for endpoint in ("browse", "next", "player", "search", "music/get_search_suggestions")
)


def _is_public_request(request: requests.PreparedRequest) -> bool:
    """Accept only the fixed catalog endpoints used by public YTMusic clients."""
    try:
        parsed = urlsplit(request.url or "")
        return (
            parsed.scheme == "https"
            and parsed.hostname == "music.youtube.com"
            and parsed.port in (None, 443)
            and parsed.username is None
            and not parsed.fragment
            and (
                (request.method == "GET" and parsed.path in {"", "/", "/playlist"})
                or (request.method == "POST" and parsed.path in _PUBLIC_POST_PATHS)
            )
        )
    except ValueError:
        return False


class PublicYTMusicHttp3Session(requests.Session):
    """Provide bounded public responses while retaining requests.Session identity."""

    def __init__(self, timeout_seconds: float) -> None:
        super().__init__()
        self.trust_env = False
        self._timeout_seconds = timeout_seconds
        self._closed = False
        # curl_cffi's constructor stub omits its documented CA bundle path type.
        options: dict[str, Any] = {
            "trust_env": False,
            "verify": certifi.where(),
            "use_thread_local_curl": False,
            "curl_options": direct_curl_options(),
        }
        self._transport = BoundedMetadataSession(**options)

    def send(self, request: requests.PreparedRequest, **kwargs: Any) -> requests.Response:
        """Send one approved public read, with no redirect or alternate transport."""
        if self._closed:
            raise requests.ConnectionError("Public HTTP3 session is closed")
        if not _is_public_request(request):
            raise requests.ConnectionError("Unapproved public HTTP3 endpoint")
        if any(key in request.headers for key in ("Authorization", "Proxy-Authorization")):
            raise requests.ConnectionError("Account credentials are not allowed on public HTTP3")
        cookies = SimpleCookie()
        try:
            cookie_header = request.headers.get("Cookie", "")
            if isinstance(cookie_header, bytes):
                cookie_header = cookie_header.decode("ascii")
            cookies.load(cookie_header)
        except (CookieError, UnicodeError):
            raise requests.ConnectionError("Invalid public HTTP3 cookies") from None
        if cookie_header and (
            set(cookies) != {"SOCS"} or cookies["SOCS"].OutputString() != cookie_header.strip()
        ):
            raise requests.ConnectionError("Account cookies are not allowed on public HTTP3")
        if kwargs.get("proxies") or kwargs.get("cert") or kwargs.get("verify") is False:
            raise requests.ConnectionError("Public HTTP3 requires its verified direct transport")
        if request.body is not None and not isinstance(request.body, (str, bytes)):
            raise requests.ConnectionError("Streaming public HTTP3 request bodies are unsupported")

        timeout = kwargs.get("timeout")
        if isinstance(timeout, (tuple, list)):
            timeout = sum(timeout)
        budget = min(
            float(timeout) if timeout is not None else self._timeout_seconds,
            self._timeout_seconds,
        )
        if not math.isfinite(budget) or budget <= 0:
            raise requests.Timeout("Public HTTP3 request budget expired")
        connect = min(3.0, budget / 2)
        try:
            result = self._transport.request(
                request.method,
                request.url,
                headers=dict(request.headers),
                data=request.body,
                http_version="v3only",
                allow_redirects=False,
                timeout=(connect, budget - connect),
            )
        except RequestException as error:
            code = int(error.code)
            error_type = {28: requests.Timeout, 60: requests.exceptions.SSLError}.get(
                code, requests.ConnectionError
            )
            # Curl errors may contain account data, proxy credentials or query parameters.
            raise error_type(f"Public HTTP3 transport failed (code {code})") from None

        if result.status_code in {301, 302, 303, 307, 308}:
            raise requests.ConnectionError("Public HTTP3 redirect rejected")
        response = requests.Response()
        response.status_code = result.status_code
        response.headers.update(result.headers.items())
        response.reason = result.reason
        response.url = result.url
        response.request = request
        response.encoding = requests.utils.get_encoding_from_headers(response.headers) or "utf-8"
        response._content = result.content
        response._content_consumed = True
        return response

    def close(self) -> None:
        """Close the single owned curl handle once, after all public leases drain."""
        if not self._closed:
            self._closed = True
            self._transport.close()
        super().close()
