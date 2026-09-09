"""Validated music playback does not initialize unrelated site extractors."""

import pytest
import yt_dlp
from yt_dlp.extractor.youtube import YoutubeIE


@pytest.mark.parametrize("mode", ["stream", "spool", "regular"])
def test_playback_registers_only_youtube_and_resolves_video(monkeypatch, mode):
    import ytmusic_stream as stream

    if mode == "spool":
        options = stream._build_ytmusic_spool_options(
            "abcdefghijk", "HIGH", match_filter=lambda *_a: None, progress_hook=lambda *_a: None
        )
    elif mode == "regular":
        monkeypatch.setattr(stream, "_extract_stream_info", lambda _k, _u, opts, *_a: opts)
        options = stream._get_yt_stream_url_sync("abcdefghijk")
    else:
        options = stream._build_ytmusic_stream_options("HIGH")

    # Exercise the real upstream registration and dispatch without external I/O.
    monkeypatch.setattr(YoutubeIE, "initialize", lambda _self: None)
    monkeypatch.setattr(
        YoutubeIE,
        "_real_extract",
        lambda _self, _url: {"id": "abcdefghijk", "title": "audio", "url": "https://cdn.test/a"},
    )
    with yt_dlp.YoutubeDL(options) as downloader:
        assert set(downloader._ies) == {"Youtube"}
        result = downloader.extract_info(
            "https://music.youtube.com/watch?v=abcdefghijk", download=False, process=False
        )
    assert result["id"] == "abcdefghijk"
