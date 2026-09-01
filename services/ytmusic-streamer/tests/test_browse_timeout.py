"""Tests for bounded public ytmusicapi browse calls."""

from __future__ import annotations

import json
import time
import types
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import requests
from httpx import AsyncClient

VIDEO_ID = "dQw4w9WgXcQ"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "method_name"),
    [
        ("/album/x", "get_album"),
        ("/artist/x", "get_artist"),
        (f"/song/{VIDEO_ID}", "get_song"),
    ],
)
async def test_slow_public_browse_returns_504(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, path: Any, method_name: str
) -> None:
    """A stalled public metadata browse should return HTTP 504."""
    import app

    def slow_browse(_identifier: Any) -> Any:
        time.sleep(0.5)
        return {}

    public_client = types.SimpleNamespace(**{method_name: slow_browse})
    monkeypatch.setattr(app, "BROWSE_TIMEOUT", 0.05)
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get(f"{path}?user_id=__public__")

    assert response.status_code == 504
    assert response.json()["error"] == "YouTube Music request timed out"


@pytest.mark.anyio
async def test_fast_public_album_browse_preserves_response_shape(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fast public album browse should retain the existing success response."""
    import app

    public_client = types.SimpleNamespace(
        get_album=lambda browse_id: {
            "title": "t",
            "artists": [],
            "thumbnails": [],
            "tracks": [],
        }
    )
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get("/album/x?user_id=__public__")

    assert response.status_code == 200
    assert response.json() == {
        "browseId": "x",
        "title": "t",
        "artist": "Unknown",
        "artists": [],
        "year": None,
        "trackCount": None,
        "duration": None,
        "type": "Album",
        "thumbnails": [],
        "coverUrl": None,
        "tracks": [],
        "description": None,
    }


@pytest.mark.anyio
async def test_public_song_retries_transient_json_failure_with_fresh_client(
    client: AsyncClient,
) -> None:
    """A poisoned public session should not leave song metadata unavailable."""
    stale_client = MagicMock()
    stale_client.get_song.side_effect = json.JSONDecodeError(
        "empty upstream response",
        "",
        0,
    )
    fresh_client = MagicMock()
    fresh_client.get_song.return_value = {
        "videoDetails": {
            "videoId": VIDEO_ID,
            "title": "Recovered song",
            "author": "Recovered artist",
            "lengthSeconds": "181",
        }
    }

    with (
        patch(
            "app._get_public_ytmusic",
            side_effect=[stale_client, fresh_client],
        ) as get_public,
        patch("app._invalidate_public_ytmusic") as invalidate_public,
    ):
        response = await client.get(f"/song/{VIDEO_ID}?user_id=__public__")

    assert response.status_code == 200
    assert response.json()["title"] == "Recovered song"
    assert response.json()["duration"] == 181
    assert get_public.call_count == 2
    invalidate_public.assert_called_once_with("native", expected=stale_client)


@pytest.mark.anyio
async def test_public_song_transport_timeout_is_not_retried(client: AsyncClient) -> None:
    """One provider timeout must not multiply the public metadata deadline."""
    stalled_client = MagicMock()
    stalled_client.get_song.side_effect = requests.Timeout("provider stalled")

    with (
        patch("app._get_public_ytmusic", return_value=stalled_client) as get_public,
        patch("app._invalidate_public_ytmusic") as invalidate_public,
    ):
        response = await client.get(f"/song/{VIDEO_ID}?user_id=__public__")

    assert response.status_code == 500
    assert response.json() == {"error": "Failed to load song"}
    assert get_public.call_count == 1
    invalidate_public.assert_not_called()
