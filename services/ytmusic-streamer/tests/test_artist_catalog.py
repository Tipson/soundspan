"""Regression coverage for complete provider artist release catalogs."""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient


@pytest.mark.anyio
async def test_artist_merges_all_album_and_single_release_pages(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Artist browse must not discard expanded albums or the singles shelf."""
    import app

    class PublicArtistClient:
        def get_artist(self, channel_id: str) -> dict[str, Any]:
            assert channel_id == "UCartist"
            return {
                "name": "Catalog Artist",
                "albums": {
                    "browseId": channel_id,
                    "params": "album-params",
                    "results": [
                        {"browseId": "album-preview", "title": "Album preview"}
                    ],
                },
                "singles": {
                    "browseId": channel_id,
                    "params": "single-params",
                    "results": [
                        {
                            "browseId": "single-preview",
                            "title": "Single preview",
                            "type": "Single",
                        }
                    ],
                },
            }

        def get_artist_albums(
            self, channel_id: str, params: str, limit: int | None = 100
        ) -> list[dict[str, Any]]:
            assert channel_id == "UCartist"
            assert limit is None
            if params == "album-params":
                return [
                    {"browseId": "album-preview", "title": "Album preview"},
                    {"browseId": "album-full", "title": "Album full"},
                ]
            assert params == "single-params"
            return [
                {
                    "browseId": "single-preview",
                    "title": "Single preview",
                    "type": "Single",
                },
                {"browseId": "single-full", "title": "Single full"},
            ]

    monkeypatch.setattr(
        app,
        "_get_public_ytmusic",
        lambda strategy: PublicArtistClient(),
    )

    response = await client.get("/artist/UCartist?user_id=__public__")

    assert response.status_code == 200
    assert [release["browseId"] for release in response.json()["albums"]] == [
        "album-preview",
        "album-full",
        "single-preview",
        "single-full",
    ]
    assert [release["type"] for release in response.json()["albums"]] == [
        "Album",
        "Album",
        "Single",
        "Single",
    ]
