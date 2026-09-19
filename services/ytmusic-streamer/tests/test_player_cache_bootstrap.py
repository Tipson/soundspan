"""An optional preprocessing optimization cannot block normal audio extraction."""

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest


def test_only_tested_version_imports_private_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    import ytmusic_stream as stream

    imports = []

    def load(name):
        imports.append(name)
        if name != "yt_dlp.version":
            raise AssertionError("Private adapter must not load on an unknown version")
        return SimpleNamespace(__version__="2099.01.01")

    monkeypatch.setattr(stream, "import_module", load)
    stream._ensure_player_cache()
    stream._ensure_player_cache()
    assert imports == ["yt_dlp.version"]


def test_concurrent_bootstrap_registers_once(monkeypatch: pytest.MonkeyPatch) -> None:
    import ytmusic_stream as stream

    calls = []

    def register():
        calls.append("register")
        return True

    def load(name):
        return (
            SimpleNamespace(__version__="2026.08.19")
            if name == "yt_dlp.version"
            else SimpleNamespace(register_player_cache=register)
        )

    monkeypatch.setattr(stream, "import_module", load)
    with ThreadPoolExecutor(max_workers=8) as workers:
        list(workers.map(lambda _: stream._ensure_player_cache(), range(30)))
    assert calls == ["register"]


@pytest.mark.parametrize("failure", [ImportError, AttributeError, RuntimeError])
def test_optional_bootstrap_failure_still_extracts(
    monkeypatch: pytest.MonkeyPatch, failure
) -> None:
    import yt_dlp
    import ytmusic_stream as stream

    calls = []

    def load(name):
        calls.append(name)
        if name == "yt_dlp.version":
            return SimpleNamespace(__version__="2026.08.19")
        raise failure("optional adapter unavailable")

    class Downloader:
        def __init__(self, _options):
            assert calls == ["yt_dlp.version", "ytmusic_player_cache"]

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, _url, *, download):
            assert download is False
            return {"url": "https://example.test/audio", "acodec": "opus", "ext": "webm"}

    monkeypatch.setattr(stream, "import_module", load)
    monkeypatch.setattr(stream._extract_pacer, "wait", lambda: None)
    monkeypatch.setattr(yt_dlp, "YoutubeDL", Downloader)
    result = stream._get_stream_url_sync("public", "abcdefghijk")
    assert result["acodec"] == "opus"
    assert result["url"] == "https://example.test/audio"
    stream._ensure_player_cache()
    assert len(calls) == 2
