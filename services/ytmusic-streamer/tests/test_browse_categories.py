"""Reliability tests for public mood and genre browsing."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient


@pytest.mark.anyio
async def test_moods_recreates_public_client_after_transient_json_failure(
    client: AsyncClient,
) -> None:
    """A stale public session must not leave Explore permanently empty."""
    stale_client = MagicMock()
    stale_client.get_mood_categories.side_effect = json.JSONDecodeError(
        "empty upstream response",
        "",
        0,
    )
    fresh_client = MagicMock()
    fresh_client.get_mood_categories.return_value = {
        "Moods & moments": [
            {"title": "Focus", "params": "focus-params"},
        ],
        "Genres": [
            {"title": "Electronic", "params": "electronic-params"},
        ],
    }

    with (
        patch(
            "app._get_public_ytmusic",
            side_effect=[stale_client, fresh_client],
        ) as get_public,
        patch("app._invalidate_public_ytmusic") as invalidate_public,
    ):
        response = await client.get("/moods-and-genres")

    assert response.status_code == 200
    assert response.json() == [
        {
            "title": "Moods & moments",
            "items": [{"title": "Focus", "params": "focus-params"}],
        },
        {
            "title": "Genres",
            "items": [
                {"title": "Electronic", "params": "electronic-params"},
            ],
        },
    ]
    assert get_public.call_count == 2
    invalidate_public.assert_called_once_with("native", expected=stale_client)


@pytest.mark.anyio
async def test_moods_returns_sanitized_error_after_retry_is_exhausted(
    client: AsyncClient,
) -> None:
    """The retry remains bounded and never exposes the provider response."""
    first_client = MagicMock()
    first_client.get_mood_categories.side_effect = json.JSONDecodeError(
        "provider-secret-one",
        "",
        0,
    )
    second_client = MagicMock()
    second_client.get_mood_categories.side_effect = RuntimeError(
        "provider-secret-two",
    )

    with (
        patch(
            "app._get_public_ytmusic",
            side_effect=[first_client, second_client],
        ) as get_public,
        patch("app._invalidate_public_ytmusic") as invalidate_public,
    ):
        response = await client.get("/moods-and-genres")

    assert response.status_code == 500
    assert response.json()["error"] == "Failed to load moods and genres"
    assert "provider-secret" not in response.text
    assert get_public.call_count == 2
    invalidate_public.assert_called_once_with("native", expected=first_client)
