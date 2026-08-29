"""YouTube Music client construction, credentials, and auth retry policy."""

import json
import os
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, Literal

import requests
from fastapi import HTTPException
from ytmusic_runtime import DATA_PATH, log
from ytmusicapi import OAuthCredentials, YTMusic

from services.common.sidecar_runtime_utils import validate_user_id

SEARCH_MODE = (os.getenv("YTMUSIC_SEARCH_MODE", "auto") or "auto").strip().lower()
if SEARCH_MODE not in {"tv", "native", "auto"}:
    log.warning(
        "Invalid YTMUSIC_SEARCH_MODE=%r (expected tv|native|auto); defaulting to auto",
        SEARCH_MODE,
    )
    SEARCH_MODE = "auto"

# BCP-47 language code forwarded to all YTMusic() constructors.
YTMUSIC_LANGUAGE = (os.getenv("YTMUSIC_LANGUAGE", "en") or "en").strip()
TV_CLIENT_NAME = "TVHTML5"
TV_CLIENT_VERSION = "7.20250101.00.00"
# Keep transport work inside the sidecar's default 30-second browse and shutdown budgets.
YTMUSIC_REQUEST_TIMEOUT_SECONDS = 25.0
_SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE = "_soundspan_requests_session"
_SOUNDSPAN_PUBLIC_CLIENT_STATE_ATTRIBUTE = "_soundspan_public_client_state"


@dataclass(slots=True)
class _PublicYTMusicClientState:
    """Track safe retirement for one cached public client's owned Session."""

    active_leases: int = 0
    retired: bool = False
    closed: bool = False


# Per-user authenticated clients are used for user-private operations.
_ytmusic_instances: dict[str, YTMusic] = {}
_ytmusic_instances_lock = threading.Lock()
_ytmusic_auto_tv_fallback_users: set[str] = set()
# Public unauthenticated clients are used for search and matching.
_public_ytmusic_instances: dict[Literal["tv", "native"], YTMusic] = {}
_public_ytmusic_lock = threading.Lock()


def _build_ytmusic_requests_session(
    timeout_seconds: float = YTMUSIC_REQUEST_TIMEOUT_SECONDS,
) -> requests.Session:
    """Create a pooled ytmusicapi transport with a bounded request timeout."""
    session = requests.Session()
    session.request = partial(  # type: ignore[method-assign]
        session.request,
        timeout=timeout_seconds,
    )
    return session


def _write_private_file(path: Path, content: str) -> None:
    """Write credentials with owner-only permissions, tightening existing files."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(content)
    os.chmod(path, 0o600)


def _unlink_if_exists(path: Path) -> None:
    """Remove a credential file if present (blocking; call via asyncio.to_thread)."""
    if path.exists():
        path.unlink()


def _oauth_file(user_id: str) -> Path:
    """Return the OAuth JSON path for a given user."""
    validate_user_id(user_id)
    return DATA_PATH / f"oauth_{user_id}.json"


def _client_creds_file(user_id: str) -> Path:
    """Return the OAuth client-credentials JSON path for a given user."""
    validate_user_id(user_id)
    return DATA_PATH / f"client_creds_{user_id}.json"


def _clear_user_search_fallback(user_id: str) -> None:
    """Clear per-user auto-fallback state so native search can be retried."""
    _ytmusic_auto_tv_fallback_users.discard(user_id)


def _resolve_user_search_strategy(user_id: str) -> Literal["tv", "native"]:
    """
    Resolve the active search strategy for a user.
    - tv:     always use TVHTML parser path
    - native: always use ytmusicapi yt.search()
    - auto:   start native; authenticated #813 failures pin that user to tv
    """
    if SEARCH_MODE == "tv":
        return "tv"
    if SEARCH_MODE == "native":
        return "native"
    if user_id in _ytmusic_auto_tv_fallback_users:
        return "tv"
    return "native"


def _apply_tv_client_context(yt: YTMusic) -> None:
    """Apply TVHTML5 client context required by the custom TV search parser."""
    yt.context["context"]["client"]["clientName"] = TV_CLIENT_NAME
    yt.context["context"]["client"]["clientVersion"] = TV_CLIENT_VERSION
    yt.params = "?alt=json"  # TV client must NOT send the API key


def _create_public_ytmusic(
    strategy: Literal["tv", "native"],
    request_timeout_seconds: float,
) -> YTMusic:
    """Create one public client with an operation-specific transport budget."""
    request_session = _build_ytmusic_requests_session(request_timeout_seconds)
    try:
        yt = YTMusic(
            language=YTMUSIC_LANGUAGE,
            requests_session=request_session,
        )
        setattr(yt, _SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE, request_session)
        setattr(yt, _SOUNDSPAN_PUBLIC_CLIENT_STATE_ATTRIBUTE, _PublicYTMusicClientState())
        if strategy == "tv":
            _apply_tv_client_context(yt)
    except BaseException:
        request_session.close()
        raise
    return yt


def _close_owned_ytmusic_session(yt: YTMusic | None) -> None:
    """Detach and close the requests Session owned by one client, if present."""
    if yt is None:
        return
    request_session = vars(yt).pop(
        _SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE,
        None,
    )
    close = getattr(request_session, "close", None)
    if callable(close):
        close()


def _public_ytmusic_client_state(
    yt: YTMusic,
    *,
    create: bool,
) -> _PublicYTMusicClientState | None:
    """Return the lifecycle state attached to an owned public client."""
    state = vars(yt).get(_SOUNDSPAN_PUBLIC_CLIENT_STATE_ATTRIBUTE)
    if isinstance(state, _PublicYTMusicClientState):
        return state
    if not create:
        return None
    state = _PublicYTMusicClientState()
    setattr(yt, _SOUNDSPAN_PUBLIC_CLIENT_STATE_ATTRIBUTE, state)
    return state


def _get_public_ytmusic(
    strategy: Literal["tv", "native"],
    request_timeout_seconds: float | None = None,
) -> YTMusic:
    """
    Get or create an unauthenticated YTMusic instance for public search.
    """
    # Operation-specific budgets must never reuse the default cached Session:
    # a cached 25s client would keep its blocking to_thread alive after the
    # shorter radio endpoint budget has already returned.
    if request_timeout_seconds is not None:
        return _create_public_ytmusic(strategy, request_timeout_seconds)

    with _public_ytmusic_lock:
        existing = _public_ytmusic_instances.get(strategy)
    if existing is not None:
        return existing

    candidate = _create_public_ytmusic(strategy, YTMUSIC_REQUEST_TIMEOUT_SECONDS)
    with _public_ytmusic_lock:
        existing = _public_ytmusic_instances.get(strategy)
        if existing is None:
            _public_ytmusic_instances[strategy] = candidate
            return candidate

    _close_owned_ytmusic_session(candidate)
    return existing


def _release_public_ytmusic_lease(
    yt: YTMusic,
    state: _PublicYTMusicClientState,
) -> None:
    """Release one active use and close a retired Session at the safe boundary."""
    should_close = False
    with _public_ytmusic_lock:
        if state.active_leases <= 0:
            raise RuntimeError("Public YTMusic lease released more than once")
        state.active_leases -= 1
        if state.retired and state.active_leases == 0 and not state.closed:
            state.closed = True
            should_close = True
    if should_close:
        _close_owned_ytmusic_session(yt)


@contextmanager
def _lease_public_ytmusic(
    strategy: Literal["tv", "native"],
    request_timeout_seconds: float | None = None,
) -> Iterator[YTMusic]:
    """Keep an owned Session alive and exclusive to one provider call."""
    if request_timeout_seconds is not None:
        scoped_client = _get_public_ytmusic(strategy, request_timeout_seconds)
        try:
            yield scoped_client
        finally:
            _close_owned_ytmusic_session(scoped_client)
        return

    while True:
        yt = _get_public_ytmusic(strategy)
        state: _PublicYTMusicClientState | None
        retry = False
        use_isolated_client = False
        with _public_ytmusic_lock:
            cached = _public_ytmusic_instances.get(strategy)
            state = _public_ytmusic_client_state(yt, create=cached is yt)
            if cached is yt and state is not None:
                if state.retired or state.closed:
                    retry = True
                elif state.active_leases > 0:
                    use_isolated_client = True
                else:
                    state.active_leases += 1
            elif state is not None:
                # The client was invalidated after lookup but before lease
                # acquisition. Never hand its retired/closed Session to work.
                retry = True

        if retry:
            continue

        if use_isolated_client:
            isolated_client = _create_public_ytmusic(
                strategy,
                YTMUSIC_REQUEST_TIMEOUT_SECONDS,
            )
            try:
                yield isolated_client
            finally:
                _close_owned_ytmusic_session(isolated_client)
            return

        try:
            yield yt
        finally:
            # Tests and legacy overrides may supply an unmanaged mock client.
            # Owned cached clients always carry state and must be released.
            if state is not None:
                _release_public_ytmusic_lease(yt, state)
        return


def _invalidate_public_ytmusic(
    strategy: Literal["tv", "native"],
    *,
    expected: YTMusic | None = None,
) -> bool:
    """Retire the expected cached client without evicting a newer replacement."""
    removed: YTMusic | None = None
    should_close = False
    with _public_ytmusic_lock:
        current = _public_ytmusic_instances.get(strategy)
        if current is None or (expected is not None and current is not expected):
            return False
        removed = _public_ytmusic_instances.pop(strategy)
        state = _public_ytmusic_client_state(removed, create=True)
        if state is None:  # pragma: no cover - create=True always returns state
            return True
        state.retired = True
        if state.active_leases == 0 and not state.closed:
            state.closed = True
            should_close = True

    if should_close:
        _close_owned_ytmusic_session(removed)
    return True


def _run_public_ytmusic(
    strategy: Literal["tv", "native"],
    func: Callable[[YTMusic], Any],
    *,
    request_timeout_seconds: float | None = None,
) -> Any:
    """Run one public provider call while retaining its owned Session."""
    with _lease_public_ytmusic(strategy, request_timeout_seconds) as yt:
        return func(yt)


def _run_public_ytmusic_with_retry(
    strategy: Literal["tv", "native"],
    operation: str,
    func: Callable[[YTMusic], Any],
    *,
    request_timeout_seconds: float | None = None,
    retry_timeouts: bool = True,
) -> Any:
    """Run one idempotent public browse call with a fresh-client retry.

    YouTube occasionally returns an empty or otherwise unparsable browse
    response.  A cached ``requests.Session`` can then keep Explore in a broken
    state until the sidecar restarts.  Rebuilding the client once is bounded,
    safe for read-only browse calls, and leaves the final error mapping to the
    owning HTTP route.
    """

    attempted_client: YTMusic | None = None

    def run_once() -> Any:
        nonlocal attempted_client
        with _lease_public_ytmusic(strategy, request_timeout_seconds) as yt:
            attempted_client = yt
            return func(yt)

    try:
        return run_once()
    except Exception as first_error:
        if not retry_timeouts and isinstance(first_error, requests.Timeout):
            raise
        log.warning(
            "Public YTMusic %s failed with %s; recreating client and retrying once",
            operation,
            type(first_error).__name__,
        )
        if request_timeout_seconds is None and attempted_client is not None:
            _invalidate_public_ytmusic(strategy, expected=attempted_client)
        return run_once()


def _get_ytmusic(user_id: str) -> YTMusic:
    """Get or create an authenticated YTMusic instance for a specific user."""
    with _ytmusic_instances_lock:
        existing = _ytmusic_instances.get(user_id)
    if existing:
        return existing

    oauth_path = _oauth_file(user_id)
    if oauth_path.exists():
        try:
            # Read the oauth JSON to check if it has custom client credentials
            json.loads(oauth_path.read_text())

            # Build OAuthCredentials if client_id/client_secret are stored alongside
            request_session = _build_ytmusic_requests_session()
            oauth_creds = None
            creds_path = _client_creds_file(user_id)
            if creds_path.exists():
                creds_data = json.loads(creds_path.read_text())
                oauth_creds = OAuthCredentials(
                    client_id=creds_data["client_id"],
                    client_secret=creds_data["client_secret"],
                    session=request_session,
                )

            if oauth_creds:
                yt = YTMusic(
                    str(oauth_path),
                    oauth_credentials=oauth_creds,
                    language=YTMUSIC_LANGUAGE,
                    requests_session=request_session,
                )
            else:
                yt = YTMusic(
                    str(oauth_path),
                    language=YTMUSIC_LANGUAGE,
                    requests_session=request_session,
                )

            client_mode = _resolve_user_search_strategy(user_id)
            if client_mode == "tv":
                # ── WORKAROUND(#813) START ──────────────────────────────
                # Google broke OAuth + WEB_REMIX since ~Aug 29 2025.
                # Switching the client context to TVHTML5 v7 makes OAuth
                # requests succeed. The response format is different (TV
                # renderers instead of musicShelfRenderer), so we use a
                # custom search parser (_tv_search) below.
                #
                # Original values (set by ytmusicapi's initialize_context()):
                #   clientName    = "WEB_REMIX"
                #   clientVersion = "1.yyyymmdd.xx.xx"  (auto-detected)
                #   yt.params     = "?alt=json&key=<INNERTUBE_API_KEY>"
                _apply_tv_client_context(yt)
                # ── WORKAROUND(#813) END ────────────────────────────────

            with _ytmusic_instances_lock:
                _ytmusic_instances[user_id] = yt
            log.info(
                "Loaded YTMusic for user %s (search_strategy=%s, configured_mode=%s)",
                user_id,
                client_mode,
                SEARCH_MODE,
            )
            return yt
        except Exception as e:
            log.error(f"Failed to load OAuth for user {user_id}: {e}")
            raise HTTPException(
                status_code=401,
                detail="OAuth credentials invalid. Please re-authenticate.",
            )

    raise HTTPException(
        status_code=401,
        detail="Not authenticated. Please set up OAuth first.",
    )


def _invalidate_ytmusic(user_id: str) -> None:
    """Force re-creation of a user's YTMusic instance on next use."""
    with _ytmusic_instances_lock:
        _ytmusic_instances.pop(user_id, None)


def _is_oauth_auth_error(err: Exception) -> bool:
    """Best-effort detection for OAuth expiry/revocation/auth failures."""
    if isinstance(err, HTTPException):
        return err.status_code == 401

    response = getattr(err, "response", None)
    response_status = getattr(response, "status_code", None)
    if response_status in (401, 403):
        return True

    status_code = getattr(err, "status_code", None)
    if status_code in (401, 403):
        return True

    message = str(err).lower()
    markers = (
        "invalid_grant",
        "expired_token",
        "token has expired",
        "authentication",
        "not authenticated",
        "oauth",
        "login required",
        "unauthorized",
        "forbidden",
        "invalid credentials",
        "refresh token",
        "access token",
    )
    return any(marker in message for marker in markers)


def _run_ytmusic_with_auth_retry(
    user_id: str,
    operation: str,
    func: Callable[[YTMusic], Any],
) -> Any:
    """
    Execute a YTMusic call with one invalidate/reload retry on auth errors.
    """
    yt = _get_ytmusic(user_id)

    try:
        return func(yt)
    except Exception as first_err:
        # In auto mode, transparently migrate users to TV strategy when the
        # known #813 invalid-argument failure appears on non-search calls.
        if (
            SEARCH_MODE == "auto"
            and user_id not in _ytmusic_auto_tv_fallback_users
            and _is_issue_813_invalid_argument_error(first_err)
        ):
            log.warning(
                "Detected ytmusicapi #813 signature during %s for user %s; "
                "switching this user to TV fallback and retrying once.",
                operation,
                user_id,
            )
            _ytmusic_auto_tv_fallback_users.add(user_id)
            _invalidate_ytmusic(user_id)
            try:
                fallback_client = _get_ytmusic(user_id)
                return func(fallback_client)
            except HTTPException as retry_http:
                if retry_http.status_code == 401:
                    raise HTTPException(
                        status_code=401,
                        detail="OAuth credentials expired or invalid. Please re-authenticate.",
                    )
                raise
            except Exception as retry_err:
                if _is_oauth_auth_error(retry_err):
                    _invalidate_ytmusic(user_id)
                    raise HTTPException(
                        status_code=401,
                        detail="OAuth credentials expired or invalid. Please re-authenticate.",
                    )
                raise

        if not _is_oauth_auth_error(first_err):
            raise

        log.warning(
            f"OAuth issue during {operation} for user {user_id}; reloading credentials and retrying once: {first_err}"
        )
        _invalidate_ytmusic(user_id)

        try:
            refreshed = _get_ytmusic(user_id)
            return func(refreshed)
        except HTTPException as retry_http:
            if retry_http.status_code == 401:
                raise HTTPException(
                    status_code=401,
                    detail="OAuth credentials expired or invalid. Please re-authenticate.",
                )
            raise
        except Exception as retry_err:
            if _is_oauth_auth_error(retry_err):
                _invalidate_ytmusic(user_id)
                raise HTTPException(
                    status_code=401,
                    detail="OAuth credentials expired or invalid. Please re-authenticate.",
                )
            raise


def _is_issue_813_invalid_argument_error(err: Exception) -> bool:
    """Detect the OAuth + WEB_REMIX invalid-argument failure signature."""
    response = getattr(err, "response", None)
    response_status = getattr(response, "status_code", None)
    response_text = ""
    if response is not None:
        response_text = str(getattr(response, "text", "") or "")

    message = f"{err} {response_text}".lower()
    if response_status != 400:
        return False
    markers = (
        "request contains an invalid argument",
        "invalid argument",
        "invalid_argument",
        "badrequest",
    )
    return any(marker in message for marker in markers)
