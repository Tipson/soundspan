"""Behavioral coverage for queued audio-path containment."""

from __future__ import annotations

import logging
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest
from audio_paths import resolve_music_path

from services.common.music_path import resolve_contained_music_path


class RecordingAnalyzer:
    """Record analysis requests without opening audio files."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        self.decoded_audio: list[np.ndarray | None] = []

    def analyze(
        self,
        file_path: str,
        *,
        decoded_audio: np.ndarray | None = None,
    ) -> dict[str, Any]:
        """Record the resolved path and return a successful result."""
        self.paths.append(file_path)
        self.decoded_audio.append(decoded_audio)
        return {"bpm": 120.0}


@pytest.mark.parametrize(
    "file_path",
    [
        "../outside.flac",
        "artist/../outside.flac",
        "artist/./track.flac",
        "/etc/passwd",
        "bad\x00.flac",
    ],
)
def test_common_music_path_rejects_unsafe_paths(tmp_path: Path, file_path: str) -> None:
    """Reject NUL, absolute, and explicit dot-segment paths in the shared boundary."""
    assert resolve_contained_music_path(str(tmp_path), file_path) is None


def test_common_music_path_normalizes_backslashes(tmp_path: Path) -> None:
    """Normalize Windows-style separators before resolving a contained path."""
    track_path = tmp_path / "artist" / "track.flac"
    track_path.parent.mkdir()
    track_path.touch()

    assert resolve_contained_music_path(str(tmp_path), "artist\\track.flac") == str(
        track_path.resolve()
    )


@pytest.mark.parametrize(
    "file_path",
    [
        "../outside.flac",
        "artist/../outside.flac",
        "artist/./track.flac",
        "/etc/passwd",
        "bad\x00.flac",
    ],
)
def test_audio_path_wrapper_rejects_unsafe_paths(tmp_path: Path, file_path: str) -> None:
    """Keep every shared rejection active through the analyzer wrapper."""
    assert resolve_music_path(str(tmp_path), file_path) is None


def _analyze_queued_path(
    module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    music_root: Path,
    queued_path: str,
) -> tuple[RecordingAnalyzer, tuple[str, str, dict[str, Any]]]:
    """Run one queued path through the process-worker boundary."""
    analyzer = RecordingAnalyzer()
    monkeypatch.setattr(module, "MUSIC_PATH", str(music_root))
    monkeypatch.setattr(module, "_process_analyzer", analyzer)
    result = module._analyze_track_in_process(("track-1", queued_path))
    return analyzer, result


@pytest.mark.parametrize("attack_kind", ["absolute", "dot_segment"])
def test_queued_traversal_path_is_rejected_without_analysis(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    attack_kind: str,
) -> None:
    """Reject absolute and parent-traversal queue values before analysis."""
    music_root = tmp_path / "music"
    music_root.mkdir()
    outside_file = tmp_path / "outside.flac"
    outside_file.touch()
    queued_path = str(outside_file) if attack_kind == "absolute" else "../outside.flac"

    with caplog.at_level(logging.WARNING):
        analyzer, result = _analyze_queued_path(
            loaded_analyzer,
            monkeypatch,
            music_root,
            queued_path,
        )

    assert analyzer.paths == []
    assert result[2] == {"_error": "Invalid audio path", "_permanent": True}
    assert "Rejected queued audio path" in caplog.text
    assert str(outside_file) not in caplog.text
    assert queued_path not in caplog.text


def test_queued_symlink_escape_is_rejected_without_analysis(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Reject an in-root symlink whose resolved target escapes the library."""
    music_root = tmp_path / "music"
    music_root.mkdir()
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (outside_dir / "track.flac").touch()
    (music_root / "linked").symlink_to(outside_dir, target_is_directory=True)

    analyzer, result = _analyze_queued_path(
        loaded_analyzer,
        monkeypatch,
        music_root,
        "linked/track.flac",
    )

    assert analyzer.paths == []
    assert result[2] == {"_error": "Invalid audio path", "_permanent": True}


def test_queued_in_library_path_is_analyzed(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Resolve and analyze a valid relative path beneath the music library."""
    music_root = tmp_path / "music"
    track_path = music_root / "artist" / "track.flac"
    track_path.parent.mkdir(parents=True)
    track_path.touch()

    analyzer, result = _analyze_queued_path(
        loaded_analyzer,
        monkeypatch,
        music_root,
        "artist/track.flac",
    )

    assert analyzer.paths == [str(track_path.resolve())]
    assert analyzer.decoded_audio == [None]
    assert result == ("track-1", "artist/track.flac", {"bpm": 120.0})


def test_owned_remote_audio_is_decoded_before_analyzer(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Route only the generated canonical-spool form around Essentia MonoLoader."""
    music_root = tmp_path / "music"
    queued_path = ".soundspan-analysis-spool/123e4567-e89b-12d3-a456-426614174000.audio"
    track_path = music_root / queued_path
    track_path.parent.mkdir(parents=True)
    track_path.touch()
    decoded_audio = np.ones(44_100, dtype=np.float32)
    decode_calls: list[tuple[str, int, float]] = []

    def decode(
        file_path: str,
        *,
        max_duration: int,
        timeout_seconds: float,
    ) -> np.ndarray:
        decode_calls.append((file_path, max_duration, timeout_seconds))
        return decoded_audio

    monkeypatch.setattr(loaded_analyzer.remote_audio_decode, "decode_remote_audio", decode)
    analyzer, result = _analyze_queued_path(
        loaded_analyzer,
        monkeypatch,
        music_root,
        queued_path,
    )

    assert decode_calls == [(str(track_path.resolve()), 90, 120.0)]
    assert analyzer.paths == [str(track_path.resolve())]
    assert analyzer.decoded_audio == [decoded_audio]
    assert result == ("track-1", queued_path, {"bpm": 120.0})


def test_owned_remote_memory_error_stays_nonempty_through_process_boundary(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Never turn an empty MemoryError message into a successful canonical result."""
    music_root = tmp_path / "music"
    queued_path = ".soundspan-analysis-spool/123e4567-e89b-12d3-a456-426614174000.audio"
    track_path = music_root / queued_path
    track_path.parent.mkdir(parents=True)
    track_path.touch()

    def fail_decode(*_args: object, **_kwargs: object) -> np.ndarray:
        raise MemoryError()

    monkeypatch.setattr(loaded_analyzer.remote_audio_decode, "decode_remote_audio", fail_decode)
    analyzer, result = _analyze_queued_path(
        loaded_analyzer,
        monkeypatch,
        music_root,
        queued_path,
    )

    assert analyzer.paths == []
    assert result == (
        "track-1",
        queued_path,
        {"_error": "Remote audio decode failed unexpectedly", "_permanent": True},
    )
