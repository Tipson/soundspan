"""Behavioral tests for YouTube Music stream error classification."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

VIDEO_ID = "dQw4w9WgXcQ"


def _youtube_dl_raising(message: str) -> type:
    """Build a yt-dlp fake that fails extraction with one provider message."""

    class FailingYoutubeDL:
        def __init__(self, _options: dict[str, Any]) -> None:
            pass

        def __enter__(self) -> FailingYoutubeDL:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def extract_info(self, _url: str, *, download: bool) -> None:
            _ = download
            raise RuntimeError(message)

    return FailingYoutubeDL


@pytest.mark.anyio
@pytest.mark.parametrize(
    "provider_message",
    (
        "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable",
        "ERROR: [youtube] dQw4w9WgXcQ: This video is no longer available",
        "ERROR: [youtube] dQw4w9WgXcQ: This video is private",
        "ERROR: [youtube] dQw4w9WgXcQ: This video has been removed by the uploader",
        "ERROR: [youtube] dQw4w9WgXcQ: This video has been deleted",
        (
            "ERROR: [youtube] dQw4w9WgXcQ: This video is no longer available "
            "because the associated YouTube account has been terminated"
        ),
    ),
)
async def test_stream_endpoint_maps_permanent_provider_failures_to_404(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    provider_message: str,
) -> None:
    """Permanent content loss should cross the sidecar boundary as HTTP 404."""
    import app
    import yt_dlp

    monkeypatch.setattr(app._extract_pacer, "wait", lambda: 0.0)
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _youtube_dl_raising(provider_message))

    response = await client.get(f"/stream/{VIDEO_ID}?user_id=__public__")

    assert response.status_code == 404
    assert response.json() == {
        "error": "content_unavailable",
        "message": "This content is unavailable and cannot be streamed.",
        "video_id": VIDEO_ID,
    }


@pytest.mark.anyio
async def test_stream_endpoint_keeps_age_restriction_at_451(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Age verification remains distinct from permanently missing content."""
    import app
    import yt_dlp

    monkeypatch.setattr(app._extract_pacer, "wait", lambda: 0.0)
    monkeypatch.setattr(
        yt_dlp,
        "YoutubeDL",
        _youtube_dl_raising("Sign in to confirm your age. This video may be inappropriate."),
    )

    response = await client.get(f"/stream/{VIDEO_ID}?user_id=__public__")

    assert response.status_code == 451
    assert response.json()["error"] == "age_restricted"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "provider_message",
    (
        "Remote end closed connection without response",
        "Requested format is not available",
        "Unable to extract player response; please report this issue",
    ),
)
async def test_stream_endpoint_keeps_transient_extraction_failures_at_502(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    provider_message: str,
) -> None:
    """Network, format, and extractor failures must not trigger identity recovery."""
    import app
    import yt_dlp

    monkeypatch.setattr(app._extract_pacer, "wait", lambda: 0.0)
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _youtube_dl_raising(provider_message))

    response = await client.get(f"/stream/{VIDEO_ID}?user_id=__public__")

    assert response.status_code == 502
    assert response.json() == {"error": "Failed to extract stream"}


def test_spool_uses_the_same_permanent_unavailable_mapping(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Cold HLS spool failures share the metadata endpoint's status contract."""
    import yt_dlp
    import ytmusic_stream

    monkeypatch.setattr(ytmusic_stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(
        yt_dlp,
        "YoutubeDL",
        _youtube_dl_raising("Private video. Sign in if you've been granted access"),
    )

    with pytest.raises(HTTPException) as raised:
        ytmusic_stream._download_ytmusic_spool_sync(VIDEO_ID, "HIGH")

    assert raised.value.status_code == 404
    detail = cast(dict[str, object], raised.value.detail)
    assert detail["error"] == "content_unavailable"
