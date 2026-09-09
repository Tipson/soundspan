"""A direct player response is usable only for an unambiguous original HIGH stream."""

import copy

import pytest


def response():
    return {
        "playabilityStatus": {"status": "OK"},
        "videoDetails": {
            "videoId": "Abcdef01234",
            "title": "Original",
            "author": "Artist",
            "lengthSeconds": "220",
        },
        "streamingData": {
            "adaptiveFormats": [
                {
                    "itag": 251,
                    "url": "https://rr1.googlevideo.com/videoplayback?sig=valid",
                    "mimeType": 'audio/webm; codecs="opus"',
                    "bitrate": 150000,
                }
            ]
        },
    }


def test_direct_audio_preserves_original_identity_quality_and_duration():
    from ytmusic_fast_probe import _select_direct_audio

    data = response()
    original = copy.deepcopy(data)
    selected = _select_direct_audio(data, "Abcdef01234")
    assert selected["format_id"] == "251"
    assert selected["acodec"] == "opus" and selected["abr"] == 150
    assert selected["duration"] == 220 and selected["title"] == "Original"
    assert selected["url"] == data["streamingData"]["adaptiveFormats"][0]["url"]
    assert data == original


def test_direct_probe_owns_downloader_and_calls_only_one_player_request(monkeypatch):
    import ytmusic_anonymous_context as context
    import ytmusic_fast_probe as probe

    calls = []

    def player(_self, client, video, _web, _cfg, player_url, _initial, visitor, _sync, token):
        calls.append((client, video, player_url, visitor, token))
        return response()

    monkeypatch.setattr(context._AudioOnlyYoutubeIE, "_extract_player_response", player)
    result = probe.extract_fast(
        "https://music.youtube.com/watch?v=Abcdef01234",
        {
            "allowed_extractors": ["youtube"],
            "extractor_args": {"youtube": {"visitor_data": ["anonymous"]}},
        },
    )
    assert result["format_id"] == "251"
    assert calls == [("visionos", "Abcdef01234", None, "anonymous", None)]


@pytest.mark.parametrize(
    "problem",
    [
        "identity",
        "live",
        "cipher",
        "throttle",
        "host",
        "codec",
        "bitrate",
        "duplicate",
        "dub",
        "status",
        "malformed",
    ],
)
def test_uncertain_audio_requires_full_extractor(problem):
    from ytmusic_fast_probe import _select_direct_audio

    data = response()
    fmt = data["streamingData"]["adaptiveFormats"][0]
    if problem == "identity":
        data["videoDetails"]["videoId"] = "different"
    elif problem == "live":
        data["videoDetails"]["isLiveContent"] = True
    elif problem == "cipher":
        fmt["signatureCipher"] = "encrypted"
    elif problem == "throttle":
        fmt["url"] += "&n=needs-transform"
    elif problem == "host":
        fmt["url"] = "https://googlevideo.com.attacker.test/audio"
    elif problem == "codec":
        fmt["mimeType"] = 'audio/mp4; codecs="mp4a"'
    elif problem == "bitrate":
        fmt["bitrate"] = 300000
    elif problem == "duplicate":
        data["streamingData"]["adaptiveFormats"].append(dict(fmt))
    elif problem == "dub":
        fmt["audioTrack"] = {"audioIsDefault": True, "displayName": "Dubbed"}
    elif problem == "status":
        data["playabilityStatus"]["status"] = "UNPLAYABLE"
    elif problem == "malformed":
        fmt["bitrate"] = "not-a-number"
    assert _select_direct_audio(data, "Abcdef01234") == {}
