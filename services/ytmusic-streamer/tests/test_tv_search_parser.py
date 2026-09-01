"""Behavior tests for the TVHTML5 search response parser."""

from __future__ import annotations

from typing import Any


class _FakeYTMusic:
    """Return a fixed InnerTube response without contacting YouTube."""

    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response

    def _send_request(self, endpoint: str, body: dict[str, object]) -> dict[str, Any]:
        assert endpoint == "search"
        assert body["query"] == "Linkin Park Numb"
        return self.response


def _lockup_view_model(video_id: str = "kXYiU_JCYtU") -> dict[str, Any]:
    return {
        "lockupViewModel": {
            "contentType": "LOCKUP_CONTENT_TYPE_MUSIC",
            "contentId": video_id,
            "rendererContext": {
                "commandContext": {
                    "onTap": {"innertubeCommand": {"watchEndpoint": {"videoId": video_id}}}
                }
            },
            "metadata": {
                "lockupMetadataViewModel": {
                    "title": {"content": "Numb"},
                    "metadata": {
                        "contentMetadataViewModel": {
                            "metadataRows": [
                                {
                                    "metadataParts": [
                                        {"text": {"content": "Linkin Park"}},
                                        {"text": {"content": "Meteora"}},
                                        {"text": {"content": "2.1B views"}},
                                    ]
                                }
                            ]
                        }
                    },
                }
            },
            "contentImage": {
                "thumbnailViewModel": {
                    "image": {
                        "sources": [
                            {
                                "url": "https://i.ytimg.com/vi/kXYiU_JCYtU/hqdefault.jpg",
                                "width": 480,
                                "height": 360,
                            }
                        ]
                    },
                    "overlays": [
                        {
                            "thumbnailBottomOverlayViewModel": {
                                "badges": [
                                    {
                                        "thumbnailBadgeViewModel": {
                                            "text": {"content": "3:05"},
                                            "rendererContext": {
                                                "accessibilityContext": {
                                                    "label": "3 minutes, 5 seconds"
                                                }
                                            },
                                        }
                                    }
                                ]
                            }
                        }
                    ],
                }
            },
        }
    }


def test_tv_search_parses_current_lockup_view_model_and_deduplicates() -> None:
    import app

    lockup = _lockup_view_model()
    yt = _FakeYTMusic({"contents": [lockup, lockup]})

    results = app._tv_search(yt, "Linkin Park Numb", filter="songs", limit=20)

    assert results == [
        {
            "type": "song",
            "videoId": "kXYiU_JCYtU",
            "title": "Numb",
            "artist": "Linkin Park",
            "artists": ["Linkin Park"],
            "album": "Meteora",
            "duration": "3:05",
            "duration_seconds": 185,
            "thumbnails": [
                {
                    "url": "https://i.ytimg.com/vi/kXYiU_JCYtU/hqdefault.jpg",
                    "width": 480,
                    "height": 360,
                }
            ],
            "isExplicit": False,
        }
    ]


def test_tv_search_uses_valid_lockup_content_id_when_watch_endpoint_is_absent() -> None:
    import app

    lockup = _lockup_view_model("dQw4w9WgXcQ")
    lockup["lockupViewModel"]["rendererContext"] = {}
    yt = _FakeYTMusic({"contents": [lockup]})

    results = app._tv_search(yt, "Linkin Park Numb", limit=20)

    assert [result["videoId"] for result in results] == ["dQw4w9WgXcQ"]


def test_tv_search_prefers_valid_content_id_over_malformed_watch_id() -> None:
    import app

    lockup = _lockup_view_model("dQw4w9WgXcQ")
    watch_endpoint = lockup["lockupViewModel"]["rendererContext"]["commandContext"]["onTap"][
        "innertubeCommand"
    ]["watchEndpoint"]
    watch_endpoint["videoId"] = "not a video id"
    yt = _FakeYTMusic({"contents": [lockup]})

    results = app._tv_search(yt, "Linkin Park Numb", limit=20)

    assert [result["videoId"] for result in results] == ["dQw4w9WgXcQ"]


def test_tv_search_skips_malformed_lockups_without_losing_later_results() -> None:
    import app

    malformed: dict[str, Any] = {
        "lockupViewModel": {
            "contentType": "LOCKUP_CONTENT_TYPE_MUSIC",
            "rendererContext": None,
            "metadata": [],
            "contentImage": None,
        }
    }
    valid = _lockup_view_model("Zi_XLOBDo_Y")
    yt = _FakeYTMusic({"contents": [malformed, valid]})

    results = app._tv_search(yt, "Linkin Park Numb", limit=20)

    assert [result["videoId"] for result in results] == ["Zi_XLOBDo_Y"]


def test_tv_search_rejects_noncanonical_watch_endpoint_video_id() -> None:
    import app

    invalid = _lockup_view_model("not a video id")
    yt = _FakeYTMusic({"contents": [invalid]})

    results = app._tv_search(yt, "Linkin Park Numb", limit=20)

    assert results == []


def test_native_search_normalizer_preserves_album_and_artist_browse_identities() -> None:
    import app

    album = app._normalize_native_search_item(
        {
            "resultType": "album",
            "browseId": "MPREb_album-1",
            "title": "Mezzanine",
            "artist": "Massive Attack",
            "year": "1998",
            "thumbnails": [{"url": "https://img/album.jpg"}],
        }
    )
    artist = app._normalize_native_search_item(
        {
            "resultType": "artist",
            "browseId": "UCmassiveattack",
            "artist": "Massive Attack",
            "thumbnails": [{"url": "https://img/artist.jpg"}],
        }
    )

    assert album == {
        "type": "album",
        "browseId": "MPREb_album-1",
        "title": "Mezzanine",
        "artist": "Massive Attack",
        "artists": ["Massive Attack"],
        "year": "1998",
        "thumbnails": [{"url": "https://img/album.jpg"}],
        "isExplicit": False,
    }
    assert artist == {
        "type": "artist",
        "browseId": "UCmassiveattack",
        "channelId": "UCmassiveattack",
        "title": "Massive Attack",
        "artist": "Massive Attack",
        "thumbnails": [{"url": "https://img/artist.jpg"}],
    }


def test_tv_search_preserves_browsable_album_and_artist_lockups() -> None:
    import app

    def browse_lockup(
        content_type: str, browse_id: str, title: str, metadata_values: list[str]
    ) -> dict[str, Any]:
        return {
            "lockupViewModel": {
                "contentType": content_type,
                "contentId": browse_id,
                "rendererContext": {
                    "commandContext": {
                        "onTap": {"innertubeCommand": {"browseEndpoint": {"browseId": browse_id}}}
                    }
                },
                "metadata": {
                    "lockupMetadataViewModel": {
                        "title": {"content": title},
                        "metadata": {
                            "contentMetadataViewModel": {
                                "metadataRows": [
                                    {
                                        "metadataParts": [
                                            {"text": {"content": value}}
                                            for value in metadata_values
                                        ]
                                    }
                                ]
                            }
                        },
                    }
                },
                "contentImage": {
                    "thumbnailViewModel": {
                        "image": {"sources": [{"url": f"https://img/{browse_id}.jpg"}]}
                    }
                },
            }
        }

    album_yt = _FakeYTMusic(
        {
            "contents": [
                browse_lockup(
                    "LOCKUP_CONTENT_TYPE_ALBUM",
                    "MPREb_album-1",
                    "Mezzanine",
                    ["Massive Attack", "1998"],
                )
            ]
        }
    )
    artist_yt = _FakeYTMusic(
        {
            "contents": [
                browse_lockup(
                    "LOCKUP_CONTENT_TYPE_ARTIST",
                    "UCmassiveattack",
                    "Massive Attack",
                    [],
                )
            ]
        }
    )
    ambiguous_channel_yt = _FakeYTMusic(
        {
            "contents": [
                browse_lockup(
                    "LOCKUP_CONTENT_TYPE_CHANNEL",
                    "UClinkinpark",
                    "Linkin Park",
                    [],
                )
            ]
        }
    )
    tv_album_yt = _FakeYTMusic(
        {
            "contents": [
                browse_lockup(
                    "LOCKUP_CONTENT_TYPE_ALBUM",
                    "VLOLAK5uy_album-1",
                    "Hybrid Theory",
                    ["Linkin Park", "2000"],
                )
            ]
        }
    )
    playlist_mislabeled_as_album_yt = _FakeYTMusic(
        {
            "contents": [
                browse_lockup(
                    "LOCKUP_CONTENT_TYPE_CONTENT",
                    "VLPLnot-an-album",
                    "Full album playlist",
                    ["Uploader"],
                )
            ]
        }
    )

    assert app._tv_search(album_yt, "Linkin Park Numb", filter="albums", limit=20) == [
        {
            "type": "album",
            "browseId": "MPREb_album-1",
            "title": "Mezzanine",
            "artist": "Massive Attack",
            "artists": ["Massive Attack"],
            "year": "1998",
            "thumbnails": [{"url": "https://img/MPREb_album-1.jpg"}],
            "isExplicit": False,
        }
    ]
    assert app._tv_search(artist_yt, "Linkin Park Numb", filter="artists", limit=20) == [
        {
            "type": "artist",
            "browseId": "UCmassiveattack",
            "channelId": "UCmassiveattack",
            "title": "Massive Attack",
            "artist": "Massive Attack",
            "thumbnails": [{"url": "https://img/UCmassiveattack.jpg"}],
        }
    ]
    assert app._tv_search(artist_yt, "Linkin Park Numb", filter="albums", limit=20) == []
    assert app._tv_search(album_yt, "Linkin Park Numb", filter="artists", limit=20) == []
    assert app._tv_search(
        tv_album_yt,
        "Linkin Park Numb",
        filter="albums",
        limit=20,
    ) == [
        {
            "type": "album",
            "browseId": "VLOLAK5uy_album-1",
            "title": "Hybrid Theory",
            "artist": "Linkin Park",
            "artists": ["Linkin Park"],
            "year": "2000",
            "thumbnails": [{"url": "https://img/VLOLAK5uy_album-1.jpg"}],
            "isExplicit": False,
        }
    ]
    assert (
        app._tv_search(
            playlist_mislabeled_as_album_yt,
            "Linkin Park Numb",
            filter="albums",
            limit=20,
        )
        == []
    )
    assert (
        app._tv_search(
            ambiguous_channel_yt,
            "Linkin Park Numb",
            filter="albums",
            limit=20,
        )
        == []
    )
    assert app._tv_search(
        ambiguous_channel_yt,
        "Linkin Park Numb",
        filter="artists",
        limit=20,
    ) == [
        {
            "type": "artist",
            "browseId": "UClinkinpark",
            "channelId": "UClinkinpark",
            "title": "Linkin Park",
            "artist": "Linkin Park",
            "thumbnails": [{"url": "https://img/UClinkinpark.jpg"}],
        }
    ]
