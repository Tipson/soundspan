"""Cold progressive lookup avoids unused manifests without losing fallback."""

from typing import Any

import pytest


@pytest.mark.parametrize("mode", ["direct", "missing", "combined", "challenge", "lossless"])
def test_music_manifest_fast_path(monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    import app
    import yt_dlp

    calls: list[bool] = []
    audio = {
        "url": "https://example.com/audio",
        "vcodec": "none",
        "acodec": "opus",
        "protocol": "https",
        "ext": "webm",
        "abr": 128,
    }

    class FakeDL:
        def __init__(self, options: Any) -> None:
            self.options = options

        def __enter__(self) -> "FakeDL":
            return self

        def __exit__(self, *_args: Any) -> None:
            pass

        def extract_info(self, _url: str, download: bool) -> dict[str, Any]:
            fast = "hls" in self.options.get("extractor_args", {}).get("youtube", {}).get(
                "skip", []
            )
            calls.append(fast)
            if mode == "challenge":
                raise yt_dlp.utils.DownloadError("Sign in to confirm your age")
            if fast and mode == "missing":
                raise yt_dlp.utils.DownloadError("Requested format is not available")
            if fast and mode == "combined":
                return {**audio, "vcodec": "h264"}
            if not fast and mode in ("missing", "combined"):
                return {**audio, "protocol": "m3u8_native"}
            return audio

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeDL)
    monkeypatch.setattr(app, "_ensure_player_cache", lambda: None)
    monkeypatch.setattr(app._extract_pacer, "wait", lambda: None)
    if mode == "challenge":
        with pytest.raises(app.HTTPException) as error:
            app._get_stream_url_sync("__public__", "dQw4w9WgXcQ", "HIGH")
        assert error.value.status_code == 451
        assert calls == [True]
        return
    quality = "LOSSLESS" if mode == "lossless" else "HIGH"
    result = app._get_stream_url_sync("__public__", "dQw4w9WgXcQ", quality)
    assert result["abr"] == 128
    fallback = mode in ("missing", "combined")
    assert calls == ([False] if mode == "lossless" else [True, False] if fallback else [True])
    assert result["protocol"] == ("m3u8_native" if fallback else "https")
    app._get_stream_url_sync("__public__", "dQw4w9WgXcQ", quality)
    assert len(calls) == (2 if fallback else 1)
