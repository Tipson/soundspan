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

    malformed = {
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
