"""Behaviour tests for provider-backed radio recommendations."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

import pytest
import requests
from httpx import AsyncClient


def test_concurrent_default_public_client_creation_closes_the_losing_session() -> None:
    """Only the published cold-cache client may retain its owned transport."""
    import ytmusic_client

    creation_barrier = threading.Barrier(2)
    created_clients: list[object] = []
    created_sessions: list[MagicMock] = []
    created_lock = threading.Lock()

    def create_public(_strategy: str, _timeout: float) -> MagicMock:
        client = MagicMock(name="public-client")
        session = MagicMock(name="owned-session")
        setattr(
            client,
            ytmusic_client._SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE,
            session,
        )
        with created_lock:
            created_clients.append(client)
            created_sessions.append(session)
        creation_barrier.wait(timeout=5)
        return client

    with (
        patch.object(ytmusic_client, "_create_public_ytmusic", side_effect=create_public),
        ThreadPoolExecutor(max_workers=2) as executor,
    ):
        futures = [executor.submit(ytmusic_client._get_public_ytmusic, "native") for _ in range(2)]
        resolved = [future.result(timeout=5) for future in futures]

    assert resolved[0] is resolved[1]
    assert ytmusic_client._public_ytmusic_instances["native"] is resolved[0]
    winner_index = created_clients.index(resolved[0])
    loser_index = 1 - winner_index
    created_sessions[winner_index].close.assert_not_called()
    created_sessions[loser_index].close.assert_called_once_with()


def test_public_client_constructor_failure_closes_the_owned_session() -> None:
    """A failed YTMusic constructor must not leak its newly allocated pool."""
    import ytmusic_client

    owned_session = MagicMock(name="owned-session")
    with (
        patch.object(
            ytmusic_client,
            "_build_ytmusic_requests_session",
            return_value=owned_session,
        ),
        patch.object(
            ytmusic_client,
            "YTMusic",
            side_effect=RuntimeError("constructor failed"),
        ),
        pytest.raises(RuntimeError, match="constructor failed"),
    ):
        ytmusic_client._get_public_ytmusic(
            "native",
            request_timeout_seconds=5.0,
        )

    owned_session.close.assert_called_once_with()


def test_public_tv_setup_failure_closes_the_owned_session() -> None:
    """A failed TV-context setup must release the constructed client's pool."""
    import ytmusic_client

    owned_session = MagicMock(name="owned-session")
    owned_client = MagicMock(name="owned-client")
    with (
        patch.object(
            ytmusic_client,
            "_build_ytmusic_requests_session",
            return_value=owned_session,
        ),
        patch.object(ytmusic_client, "YTMusic", return_value=owned_client),
        patch.object(
            ytmusic_client,
            "_apply_tv_client_context",
            side_effect=KeyError("unexpected context shape"),
        ),
        pytest.raises(KeyError, match="unexpected context shape"),
    ):
        ytmusic_client._get_public_ytmusic("tv")

    owned_session.close.assert_called_once_with()


def test_public_client_invalidation_closes_the_detached_owned_session() -> None:
    """Removing a cached client must release its attached connection pool once."""
    import ytmusic_client

    cached_client = MagicMock(name="cached-client")
    owned_session = MagicMock(name="owned-session")
    setattr(
        cached_client,
        ytmusic_client._SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE,
        owned_session,
    )
    ytmusic_client._public_ytmusic_instances["native"] = cached_client

    ytmusic_client._invalidate_public_ytmusic("native")
    ytmusic_client._invalidate_public_ytmusic("native")

    assert "native" not in ytmusic_client._public_ytmusic_instances
    assert ytmusic_client._SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE not in vars(cached_client)
    owned_session.close.assert_called_once_with()


def test_public_client_invalidation_waits_for_an_active_call_to_finish() -> None:
    """A retired cached transport must stay open until its final user exits."""
    import ytmusic_client

    cached_client = MagicMock(name="cached-client")
    owned_session = MagicMock(name="owned-session")
    setattr(
        cached_client,
        ytmusic_client._SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE,
        owned_session,
    )
    ytmusic_client._public_ytmusic_instances["native"] = cached_client
    entered = threading.Event()
    release = threading.Event()

    def use_client(yt: object) -> str:
        assert yt is cached_client
        entered.set()
        assert release.wait(timeout=5)
        return "done"

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            ytmusic_client._run_public_ytmusic,
            "native",
            use_client,
        )
        assert entered.wait(timeout=5)

        assert ytmusic_client._invalidate_public_ytmusic(
            "native",
            expected=cached_client,
        )
        owned_session.close.assert_not_called()
        release.set()
        assert future.result(timeout=5) == "done"

    owned_session.close.assert_called_once_with()


def test_late_public_failure_cannot_retire_a_replacement_client() -> None:
    """Concurrent stale failures must compare-and-remove the client they used."""
    import ytmusic_client

    stale_client = MagicMock(name="stale-client")
    stale_session = MagicMock(name="stale-session")
    setattr(
        stale_client,
        ytmusic_client._SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE,
        stale_session,
    )
    replacement_client = MagicMock(name="replacement-client")
    replacement_session = MagicMock(name="replacement-session")
    setattr(
        replacement_client,
        ytmusic_client._SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE,
        replacement_session,
    )
    ytmusic_client._public_ytmusic_instances["native"] = stale_client

    stale_attempts_entered = threading.Barrier(2)
    replacement_published = threading.Event()

    def run_role(role: str) -> str:
        attempt = 0

        def operation(yt: object) -> str:
            nonlocal attempt
            attempt += 1
            if attempt == 1:
                assert yt is stale_client
                stale_attempts_entered.wait(timeout=5)
                if role == "B":
                    assert replacement_published.wait(timeout=5)
                    stale_session.close.assert_not_called()
                raise ValueError(f"stale failure {role}")

            assert yt is replacement_client
            if role == "A":
                replacement_published.set()
            return f"recovered-{role}"

        result = ytmusic_client._run_public_ytmusic_with_retry(
            "native",
            f"concurrent {role}",
            operation,
        )
        assert isinstance(result, str)
        return result

    with (
        patch.object(
            ytmusic_client,
            "_create_public_ytmusic",
            return_value=replacement_client,
        ) as create_public,
        ThreadPoolExecutor(max_workers=2) as executor,
    ):
        future_a = executor.submit(run_role, "A")
        future_b = executor.submit(run_role, "B")
        assert future_a.result(timeout=5) == "recovered-A"
        assert future_b.result(timeout=5) == "recovered-B"

    assert ytmusic_client._public_ytmusic_instances["native"] is replacement_client
    create_public.assert_called_once_with(
        "native",
        ytmusic_client.YTMUSIC_REQUEST_TIMEOUT_SECONDS,
    )
    stale_session.close.assert_called_once_with()
    replacement_session.close.assert_not_called()

    assert ytmusic_client._invalidate_public_ytmusic(
        "native",
        expected=replacement_client,
    )
    replacement_session.close.assert_called_once_with()


def test_public_search_uses_the_leased_retry_runner() -> None:
    """Unauthenticated search must share the cache-safe retry lifecycle."""
    import app

    public_client = MagicMock(name="public-client")
    expected = [{"videoId": "search-result"}]
    app._search_cache.clear()

    def run_public(
        strategy: str,
        operation: str,
        func: object,
    ) -> object:
        assert strategy == "native"
        assert "search-native" in operation
        assert callable(func)
        return func(public_client)

    with (
        patch("app._run_public_ytmusic_with_retry", side_effect=run_public) as runner,
        patch(
            "app._get_public_ytmusic",
            side_effect=AssertionError("search bypassed the leased runner"),
        ),
        patch("app._native_search", return_value=expected) as native_search,
    ):
        result = app._search_once(
            "public-user",
            "test query",
            "songs",
            5,
            "native",
            use_unauth_client=True,
        )

    assert result == expected
    runner.assert_called_once()
    native_search.assert_called_once_with(
        public_client,
        "test query",
        filter="songs",
        limit=5,
    )


def test_custom_timeout_failure_preserves_unrelated_default_cached_client() -> None:
    """Radio retries must not evict the independent default browse transport."""
    import ytmusic_client

    default_client = MagicMock(name="default-client")
    default_session = MagicMock(name="default-session")
    setattr(
        default_client,
        ytmusic_client._SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE,
        default_session,
    )
    ytmusic_client._public_ytmusic_instances["native"] = default_client

    transient_sessions = [MagicMock(name="first-session"), MagicMock(name="retry-session")]
    transient_clients = [MagicMock(name="first-client"), MagicMock(name="retry-client")]
    for client, session in zip(transient_clients, transient_sessions, strict=True):
        setattr(
            client,
            ytmusic_client._SOUNDSPAN_REQUEST_SESSION_ATTRIBUTE,
            session,
        )

    with (
        patch.object(
            ytmusic_client,
            "_create_public_ytmusic",
            side_effect=transient_clients,
        ),
        pytest.raises(RuntimeError, match="provider unavailable"),
    ):
        ytmusic_client._run_public_ytmusic_with_retry(
            "native",
            "radio browse",
            lambda _yt: (_ for _ in ()).throw(RuntimeError("provider unavailable")),
            request_timeout_seconds=5.0,
        )

    assert ytmusic_client._public_ytmusic_instances["native"] is default_client
    default_session.close.assert_not_called()
    for session in transient_sessions:
        session.close.assert_called_once_with()


def test_radio_timeout_client_bypasses_the_default_cached_transport() -> None:
    """A prior 25s browse client must not defeat radio's shorter worker budget."""
    import ytmusic_client

    cached_default = MagicMock(name="cached-default-client")
    bounded_radio = MagicMock(name="bounded-radio-client")
    ytmusic_client._public_ytmusic_instances["native"] = cached_default

    with patch.object(
        ytmusic_client,
        "_create_public_ytmusic",
        return_value=bounded_radio,
    ) as create_public:
        resolved = ytmusic_client._get_public_ytmusic(
            "native",
            request_timeout_seconds=5.0,
        )

    assert resolved is bounded_radio
    create_public.assert_called_once_with("native", 5.0)


def test_custom_timeout_public_client_closes_its_owned_session_on_success() -> None:
    """Operation-scoped radio transports must release their pools deterministically."""
    import ytmusic_client

    owned_session = MagicMock(name="owned-session")
    owned_client = MagicMock(name="owned-client")
    with (
        patch.object(
            ytmusic_client,
            "_build_ytmusic_requests_session",
            return_value=owned_session,
        ),
        patch.object(ytmusic_client, "YTMusic", return_value=owned_client),
    ):
        result = ytmusic_client._run_public_ytmusic_with_retry(
            "native",
            "radio browse",
            lambda yt: "ok" if yt is owned_client else "wrong-client",
            request_timeout_seconds=5.0,
            retry_timeouts=False,
        )

    assert result == "ok"
    owned_session.close.assert_called_once_with()


def test_custom_timeout_public_retry_closes_every_owned_session() -> None:
    """A non-timeout retry must close both operation-scoped transports."""
    import ytmusic_client

    sessions = [MagicMock(name="first-session"), MagicMock(name="retry-session")]
    clients = [MagicMock(name="first-client"), MagicMock(name="retry-client")]
    attempts = iter([ValueError("bad provider payload"), "recovered"])

    def run(_client: object) -> str:
        outcome = next(attempts)
        if isinstance(outcome, Exception):
            raise outcome
        assert isinstance(outcome, str)
        return outcome

    with (
        patch.object(
            ytmusic_client,
            "_build_ytmusic_requests_session",
            side_effect=sessions,
        ),
        patch.object(ytmusic_client, "YTMusic", side_effect=clients),
    ):
        result = ytmusic_client._run_public_ytmusic_with_retry(
            "native",
            "radio browse",
            run,
            request_timeout_seconds=5.0,
            retry_timeouts=False,
        )

    assert result == "recovered"
    for session in sessions:
        session.close.assert_called_once_with()


def test_custom_timeout_public_timeout_closes_before_propagating() -> None:
    """A non-retried provider timeout must still release its owned transport."""
    import ytmusic_client

    owned_session = MagicMock(name="owned-session")
    with (
        patch.object(
            ytmusic_client,
            "_build_ytmusic_requests_session",
            return_value=owned_session,
        ),
        pytest.raises(requests.Timeout),
    ):
        ytmusic_client._run_public_ytmusic_with_retry(
            "native",
            "radio browse",
            lambda _yt: (_ for _ in ()).throw(requests.Timeout("stalled")),
            request_timeout_seconds=5.0,
            retry_timeouts=False,
        )

    owned_session.close.assert_called_once_with()


@pytest.mark.anyio
async def test_radio_returns_normalized_playable_tracks(client: AsyncClient) -> None:
    """A seed video should produce normalized tracks that the web player can queue."""
    mock_yt = MagicMock()
    mock_yt.get_watch_playlist.return_value = {
        "playlistId": "RDAMVMseed123",
        "tracks": [
            {
                "videoId": "seed123",
                "title": "Seed Song",
                "length": "3:01",
                "thumbnail": [{"url": "https://img/seed", "width": 120}],
                "artists": [{"name": "Seed Artist", "id": "UCseed"}],
                "album": {"name": "Seed Album", "id": "MPREseed"},
            },
            {
                "videoId": "next456",
                "title": "Related Song",
                "length": "4:05",
                "thumbnail": [
                    {"url": "https://img/small", "width": 60},
                    {"url": "https://img/large", "width": 480},
                ],
                "artists": [
                    {"name": "Related Artist", "id": "UCrelated"},
                    {"name": "Guest", "id": None},
                ],
                "album": {"name": "Related Album", "id": "MPRErelated"},
            },
            {"title": "Unplayable row", "artists": []},
        ],
    }

    with patch("app._get_public_ytmusic", return_value=mock_yt):
        response = await client.get("/radio", params={"video_id": "seed123", "limit": 20})

    assert response.status_code == 200
    assert response.json() == {
        "playlistId": "RDAMVMseed123",
        "seedVideoId": "seed123",
        "tracks": [
            {
                "videoId": "seed123",
                "title": "Seed Song",
                "artist": "Seed Artist",
                "artists": ["Seed Artist"],
                "album": "Seed Album",
                "duration": 181,
                "thumbnailUrl": "https://img/seed",
            },
            {
                "videoId": "next456",
                "title": "Related Song",
                "artist": "Related Artist",
                "artists": ["Related Artist", "Guest"],
                "album": "Related Album",
                "duration": 245,
                "thumbnailUrl": "https://img/large",
            },
        ],
    }
    mock_yt.get_watch_playlist.assert_called_once_with(
        videoId="seed123",
        limit=20,
        radio=True,
    )


@pytest.mark.anyio
async def test_radio_bounds_limit_and_rejects_blank_seed(client: AsyncClient) -> None:
    """Provider work must remain bounded and require a usable seed identity."""
    blank = await client.get("/radio", params={"video_id": " ", "limit": 20})
    oversized = await client.get("/radio", params={"video_id": "seed123", "limit": 201})

    assert blank.status_code == 400
    assert oversized.status_code == 422


@pytest.mark.anyio
async def test_radio_truncates_provider_overfetch_to_requested_limit(
    client: AsyncClient,
) -> None:
    """ytmusicapi may overfetch a minimum batch; the sidecar contract stays bounded."""
    mock_yt = MagicMock()
    mock_yt.get_watch_playlist.return_value = {
        "playlistId": "RDoverfetch",
        "tracks": [
            {"videoId": "first", "title": "First", "artists": []},
            {"videoId": "second", "title": "Second", "artists": []},
        ],
    }

    with patch("app._get_public_ytmusic", return_value=mock_yt):
        response = await client.get("/radio", params={"video_id": "seed123", "limit": 1})

    assert response.status_code == 200
    assert [track["videoId"] for track in response.json()["tracks"]] == ["first"]


@pytest.mark.anyio
async def test_radio_normalizes_non_list_artist_payload(
    client: AsyncClient,
) -> None:
    """Malformed provider artist shapes must not become one artist per character."""
    mock_yt = MagicMock()
    mock_yt.get_watch_playlist.return_value = {
        "tracks": [
            {
                "videoId": "string12345",
                "title": "String Artist",
                "artists": "Provider Artist",
            }
        ]
    }

    with patch("app._get_public_ytmusic", return_value=mock_yt):
        response = await client.get("/radio", params={"video_id": "seed123"})

    assert response.status_code == 200
    assert response.json()["tracks"][0]["artist"] == "Provider Artist"
    assert response.json()["tracks"][0]["artists"] == ["Provider Artist"]


@pytest.mark.anyio
async def test_radio_retries_a_malformed_non_list_track_payload(
    client: AsyncClient,
) -> None:
    """Malformed queues must trigger the bounded fresh-client retry."""
    malformed_yt = MagicMock()
    malformed_yt.get_watch_playlist.return_value = {"tracks": None}
    recovered_yt = MagicMock()
    recovered_yt.get_watch_playlist.return_value = {
        "tracks": [
            {
                "videoId": "recovered123",
                "title": "Recovered radio",
                "artists": [{"name": "Recovered Artist"}],
            }
        ]
    }

    with patch(
        "app._get_public_ytmusic",
        side_effect=[malformed_yt, recovered_yt],
    ) as get_public:
        response = await client.get("/radio", params={"video_id": "seed123"})

    assert response.status_code == 200
    assert response.json()["tracks"][0]["videoId"] == "recovered123"
    assert get_public.call_count == 2


@pytest.mark.anyio
async def test_radio_preserves_a_genuine_empty_queue(client: AsyncClient) -> None:
    """An explicit empty list is a valid provider response, not malformed JSON."""
    mock_yt = MagicMock()
    mock_yt.get_watch_playlist.return_value = {"tracks": []}

    with patch("app._get_public_ytmusic", return_value=mock_yt) as get_public:
        response = await client.get("/radio", params={"video_id": "seed123"})

    assert response.status_code == 200
    assert response.json()["tracks"] == []
    get_public.assert_called_once_with("native", 5.0)


@pytest.mark.anyio
async def test_radio_rejects_a_persistently_malformed_queue(
    client: AsyncClient,
) -> None:
    """Two malformed provider payloads must degrade through sanitized 500."""
    first_yt = MagicMock()
    first_yt.get_watch_playlist.return_value = {"tracks": None}
    retry_yt = MagicMock()
    retry_yt.get_watch_playlist.return_value = []

    with patch(
        "app._get_public_ytmusic",
        side_effect=[first_yt, retry_yt],
    ) as get_public:
        response = await client.get("/radio", params={"video_id": "seed123"})

    assert response.status_code == 500
    assert response.json() == {"error": "Failed to load radio"}
    assert get_public.call_count == 2


@pytest.mark.anyio
async def test_radio_sanitizes_provider_failures(client: AsyncClient) -> None:
    """Third-party provider details must not cross the sidecar boundary."""
    mock_yt = MagicMock()
    mock_yt.get_watch_playlist.side_effect = RuntimeError("private upstream detail")

    with patch("app._get_public_ytmusic", return_value=mock_yt):
        response = await client.get("/radio", params={"video_id": "seed123"})

    assert response.status_code == 500
    assert response.json() == {"error": "Failed to load radio"}


@pytest.mark.anyio
async def test_radio_recreates_public_client_after_transient_failure(
    client: AsyncClient,
) -> None:
    """A poisoned cached public client must not keep personal radio broken."""
    stale_yt = MagicMock()
    stale_yt.get_watch_playlist.side_effect = ValueError("invalid provider json")
    fresh_yt = MagicMock()
    fresh_yt.get_watch_playlist.return_value = {
        "playlistId": "RDfresh",
        "tracks": [
            {
                "videoId": "fresh123456",
                "title": "Fresh radio",
                "artists": [{"name": "Recovered Artist"}],
            }
        ],
    }

    with patch(
        "app._get_public_ytmusic",
        side_effect=[stale_yt, fresh_yt],
    ) as get_public:
        response = await client.get(
            "/radio",
            params={"video_id": "seed1234567", "limit": 12},
        )

    assert response.status_code == 200
    assert response.json()["tracks"][0]["videoId"] == "fresh123456"
    assert get_public.call_count == 2


@pytest.mark.anyio
async def test_radio_does_not_multiply_a_provider_transport_timeout(
    client: AsyncClient,
) -> None:
    """A hung provider attempt must degrade once instead of spawning a fresh retry."""
    stale_yt = MagicMock()
    stale_yt.get_watch_playlist.side_effect = requests.Timeout("provider stalled")

    with (
        patch("app._get_public_ytmusic", return_value=stale_yt) as get_public,
        patch("app._invalidate_public_ytmusic") as invalidate_public,
    ):
        response = await client.get(
            "/radio",
            params={"video_id": "seed1234567", "limit": 12},
        )

    assert response.status_code == 500
    assert response.json() == {"error": "Failed to load radio"}
    assert get_public.call_count == 1
    invalidate_public.assert_not_called()
