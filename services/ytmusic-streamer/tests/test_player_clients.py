"""Actual yt-dlp configuration must keep ordinary music extraction JS-free."""

from importlib.metadata import version
from typing import Any

import pytest
import yt_dlp
from packaging.version import Version


def test_player_policy_uses_reviewed_yt_dlp_runtime() -> None:
    """Do not validate the upgraded client policy against a stale interpreter install."""
    assert Version(version("yt-dlp")) >= Version("2026.10.26")


@pytest.mark.parametrize("spool", [False, True])
def test_ordinary_music_options_disable_javascript_players(spool: bool) -> None:
    """A configured Deno installation must not enable a solver for ordinary lookups."""
    import ytmusic_stream as stream

    options = (
        stream._build_ytmusic_spool_options(
            "dQw4w9WgXcQ",
            "HIGH",
            match_filter=lambda *_args: None,
            progress_hook=lambda _status: None,
        )
        if spool
        else stream._build_ytmusic_stream_options("HIGH")
    )
    with yt_dlp.YoutubeDL(options) as downloader:
        assert downloader.params["js_runtimes"] == {}
    assert "-tv_samsung" in options["extractor_args"]["youtube"]["player_client"]


def test_regular_youtube_clients_do_not_require_a_javascript_player() -> None:
    """Retain the fork's independently selected JS-free regular-YouTube clients."""
    from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS
    from yt_download import YT_PLAYER_CLIENTS

    clients: dict[str, Any] = INNERTUBE_CLIENTS
    assert YT_PLAYER_CLIENTS
    assert all(client in clients for client in YT_PLAYER_CLIENTS)
    assert all(not clients[client].get("REQUIRE_JS_PLAYER", True) for client in YT_PLAYER_CLIENTS)
