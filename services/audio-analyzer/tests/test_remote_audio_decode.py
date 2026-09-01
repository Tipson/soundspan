"""Behavioral coverage for bounded canonical-spool audio decoding."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from types import ModuleType

import numpy as np
import pytest
import remote_audio_decode
from remote_audio_decode import (
    MAX_REMOTE_DECODE_SECONDS,
    PCM_SAMPLE_RATE,
    RemoteAudioDecodeError,
    analyze_audio_reference,
    decode_remote_audio,
    is_remote_analysis_audio_reference,
)

REMOTE_AUDIO_REFERENCE = ".soundspan-analysis-spool/123e4567-e89b-12d3-a456-426614174000.audio"


class RecordingAnalyzer:
    """Record ordinary and predecoded analysis calls at the runtime boundary."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, np.ndarray | None]] = []

    def analyze(
        self,
        file_path: str,
        *,
        decoded_audio: np.ndarray | None = None,
    ) -> dict[str, object]:
        """Record one analysis call and return a stable feature result."""
        self.calls.append((file_path, decoded_audio))
        return {"bpm": 120.0}


@pytest.mark.parametrize(
    "reference",
    [
        REMOTE_AUDIO_REFERENCE,
        ".soundspan-analysis-spool/00000000-0000-0000-0000-000000000000.audio",
    ],
)
def test_remote_analysis_reference_accepts_only_generated_audio_assets(reference: str) -> None:
    """Recognize the exact direct-child UUID form emitted by the backend."""
    assert is_remote_analysis_audio_reference(reference) is True


@pytest.mark.parametrize(
    "reference",
    [
        "artist/track.audio",
        ".soundspan-analysis-spool/not-a-uuid.audio",
        ".soundspan-analysis-spool/123e4567-e89b-12d3-a456-426614174000.webm",
        ".soundspan-analysis-spool/nested/123e4567-e89b-12d3-a456-426614174000.audio",
        ".soundspan-analysis-spool\\123e4567-e89b-12d3-a456-426614174000.audio",
        "/.soundspan-analysis-spool/123e4567-e89b-12d3-a456-426614174000.audio",
        ".soundspan-analysis-spool/123E4567-E89B-12D3-A456-426614174000.audio",
    ],
)
def test_remote_analysis_reference_rejects_every_other_path(reference: str) -> None:
    """Keep ordinary library paths and malformed spool references on MonoLoader."""
    assert is_remote_analysis_audio_reference(reference) is False


def test_decode_remote_audio_invokes_bounded_system_ffmpeg(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Decode content-probed input to finite mono 44.1 kHz float32 PCM."""
    ffmpeg_path = tmp_path / "ffmpeg"
    ffmpeg_path.touch()
    audio_path = tmp_path / "asset.audio"
    audio_path.touch()
    expected = np.linspace(-0.5, 0.5, PCM_SAMPLE_RATE * 2, dtype=np.float32)
    calls: list[tuple[list[str], dict[str, object]]] = []

    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout=expected.astype("<f4").tobytes())

    monkeypatch.setattr(shutil, "which", lambda _name: str(ffmpeg_path))
    monkeypatch.setattr(subprocess, "run", run)

    decoded = decode_remote_audio(str(audio_path), max_duration=2, timeout_seconds=3.5)

    assert decoded.dtype == np.float32
    assert decoded.shape == expected.shape
    assert np.array_equal(decoded, expected)
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args[0] == str(ffmpeg_path.resolve())
    assert args[args.index("-i") + 1] == str(audio_path.resolve())
    assert args[args.index("-ac") + 1] == "1"
    assert args[args.index("-ar") + 1] == str(PCM_SAMPLE_RATE)
    assert args[args.index("-f") + 1] == "f32le"
    assert args[args.index("-t") + 1] == "2"
    assert int(args[args.index("-fs") + 1]) == expected.nbytes
    assert args[-1] == "pipe:1"
    assert kwargs["shell"] is False
    assert kwargs["stdout"] is subprocess.PIPE
    assert kwargs["stderr"] is subprocess.DEVNULL
    assert kwargs["timeout"] == 3.5


def test_generated_reference_is_predecoded_with_timeout_below_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Finish the FFmpeg child before a timed-out process pool can terminate Python."""
    analyzer = RecordingAnalyzer()
    decoded_audio = np.ones(PCM_SAMPLE_RATE, dtype=np.float32)
    decode_calls: list[tuple[str, int, float]] = []

    def decode(
        file_path: str,
        *,
        max_duration: int,
        timeout_seconds: float,
    ) -> np.ndarray:
        decode_calls.append((file_path, max_duration, timeout_seconds))
        return decoded_audio

    monkeypatch.setattr(remote_audio_decode, "decode_remote_audio", decode)

    result = analyze_audio_reference(
        analyzer,
        REMOTE_AUDIO_REFERENCE,
        "/music/asset.audio",
        max_duration=90,
        batch_timeout_seconds=10,
    )

    assert decode_calls == [("/music/asset.audio", 90, 5.0)]
    assert analyzer.calls == [("/music/asset.audio", decoded_audio)]
    assert result == {"bpm": 120.0}


def test_ordinary_reference_never_uses_system_decoder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Preserve MonoLoader analysis for every ordinary library reference."""
    analyzer = RecordingAnalyzer()
    monkeypatch.setattr(
        remote_audio_decode,
        "decode_remote_audio",
        lambda *_args, **_kwargs: pytest.fail("system decoder must not run"),
    )

    result = analyze_audio_reference(
        analyzer,
        "artist/track.flac",
        "/music/artist/track.flac",
        max_duration=90,
        batch_timeout_seconds=900,
    )

    assert analyzer.calls == [("/music/artist/track.flac", None)]
    assert result == {"bpm": 120.0}


def test_generated_reference_decode_failure_returns_terminal_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Give canonical persistence an explicit failure instead of a pool crash."""
    analyzer = RecordingAnalyzer()

    def fail_decode(*_args: object, **_kwargs: object) -> np.ndarray:
        raise RemoteAudioDecodeError("Remote audio decode failed")

    monkeypatch.setattr(remote_audio_decode, "decode_remote_audio", fail_decode)

    result = analyze_audio_reference(
        analyzer,
        REMOTE_AUDIO_REFERENCE,
        "/music/asset.audio",
        max_duration=90,
        batch_timeout_seconds=900,
    )

    assert analyzer.calls == []
    assert result == {"_error": "Remote audio decode failed", "_permanent": True}


def test_unexpected_remote_decode_exception_returns_safe_nonempty_error(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Keep empty or sensitive exception text out of canonical persistence."""
    analyzer = RecordingAnalyzer()

    def fail_decode(*_args: object, **_kwargs: object) -> np.ndarray:
        raise MemoryError()

    monkeypatch.setattr(remote_audio_decode, "decode_remote_audio", fail_decode)

    result = analyze_audio_reference(
        analyzer,
        REMOTE_AUDIO_REFERENCE,
        "/music/asset.audio",
        max_duration=90,
        batch_timeout_seconds=900,
    )

    assert analyzer.calls == []
    assert result == {
        "_error": "Remote audio decode failed unexpectedly",
        "_permanent": True,
    }
    assert "MemoryError" in caplog.text
    assert "/music/asset.audio" not in caplog.text


def test_decode_remote_audio_caps_configured_duration_and_output(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Clamp oversized duration configuration before starting the decoder."""
    ffmpeg_path = tmp_path / "ffmpeg"
    ffmpeg_path.touch()
    audio_path = tmp_path / "asset.audio"
    audio_path.touch()
    captured_args: list[str] = []

    def run(args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        captured_args.extend(args)
        return subprocess.CompletedProcess(args, 0, stdout=np.ones(8, dtype="<f4").tobytes())

    monkeypatch.setattr(shutil, "which", lambda _name: str(ffmpeg_path))
    monkeypatch.setattr(subprocess, "run", run)

    decode_remote_audio(str(audio_path), max_duration=MAX_REMOTE_DECODE_SECONDS * 10)

    assert captured_args[captured_args.index("-t") + 1] == str(MAX_REMOTE_DECODE_SECONDS)
    assert int(captured_args[captured_args.index("-fs") + 1]) == (
        MAX_REMOTE_DECODE_SECONDS * PCM_SAMPLE_RATE * np.dtype("<f4").itemsize
    )


@pytest.mark.parametrize(
    ("returncode", "stdout"),
    [
        (1, b""),
        (0, b""),
        (0, b"abc"),
        (0, np.array([np.nan], dtype="<f4").tobytes()),
    ],
)
def test_decode_remote_audio_rejects_invalid_decoder_results(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    returncode: int,
    stdout: bytes,
) -> None:
    """Fail closed on decoder failure, empty/truncated PCM, or non-finite samples."""
    ffmpeg_path = tmp_path / "ffmpeg"
    ffmpeg_path.touch()
    audio_path = tmp_path / "asset.audio"
    audio_path.touch()

    monkeypatch.setattr(shutil, "which", lambda _name: str(ffmpeg_path))
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda args, **_kwargs: subprocess.CompletedProcess(args, returncode, stdout=stdout),
    )

    with pytest.raises(RemoteAudioDecodeError):
        decode_remote_audio(str(audio_path), max_duration=1)


def test_decode_remote_audio_rejects_stdout_over_cap(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Validate the captured stream even when a broken decoder ignores `-fs`."""
    ffmpeg_path = tmp_path / "ffmpeg"
    ffmpeg_path.touch()
    audio_path = tmp_path / "asset.audio"
    audio_path.touch()
    output_cap = PCM_SAMPLE_RATE * np.dtype("<f4").itemsize

    monkeypatch.setattr(shutil, "which", lambda _name: str(ffmpeg_path))
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda args, **_kwargs: subprocess.CompletedProcess(
            args,
            0,
            stdout=b"\x00" * (output_cap + np.dtype("<f4").itemsize),
        ),
    )

    with pytest.raises(RemoteAudioDecodeError, match="output limit"):
        decode_remote_audio(str(audio_path), max_duration=1)


def test_decode_remote_audio_converts_timeout_to_safe_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Rely on subprocess.run's kill-and-wait timeout path without leaking stderr."""
    ffmpeg_path = tmp_path / "ffmpeg"
    ffmpeg_path.touch()
    audio_path = tmp_path / "asset.audio"
    audio_path.touch()

    def timeout(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        raise subprocess.TimeoutExpired(args, kwargs["timeout"])

    monkeypatch.setattr(shutil, "which", lambda _name: str(ffmpeg_path))
    monkeypatch.setattr(subprocess, "run", timeout)

    with pytest.raises(RemoteAudioDecodeError, match="timed out"):
        decode_remote_audio(str(audio_path), max_duration=1)


def test_decode_remote_audio_requires_resolved_ffmpeg(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Fail before spawning when the image does not provide ffmpeg."""
    audio_path = tmp_path / "asset.audio"
    audio_path.touch()
    monkeypatch.setattr(shutil, "which", lambda _name: None)

    with pytest.raises(RemoteAudioDecodeError, match="unavailable"):
        decode_remote_audio(str(audio_path), max_duration=1)


def test_analyzer_reports_monoloader_failure_instead_of_false_completion(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Turn an ordinary loader failure into an explicit analyzer result."""
    analyzer = object.__new__(loaded_analyzer.AudioAnalyzer)
    monkeypatch.setattr(loaded_analyzer, "ESSENTIA_AVAILABLE", True)
    monkeypatch.setattr(loaded_analyzer, "measure_loudness", lambda *_args: None)
    monkeypatch.setattr(loaded_analyzer, "compute_fingerprint", lambda *_args: None)
    monkeypatch.setattr(analyzer, "load_audio", lambda *_args, **_kwargs: None)

    result = analyzer.analyze("library.flac")

    assert result["_error"] == "Audio decoder returned no samples"


def test_analyzer_uses_supplied_pcm_without_calling_monoloader(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep predecoded canonical PCM away from Essentia's unsafe decoder."""
    analyzer = object.__new__(loaded_analyzer.AudioAnalyzer)
    decoded_audio = np.ones(PCM_SAMPLE_RATE, dtype=np.float32)
    monkeypatch.setattr(loaded_analyzer, "ESSENTIA_AVAILABLE", True)
    monkeypatch.setattr(loaded_analyzer, "measure_loudness", lambda *_args: None)
    monkeypatch.setattr(loaded_analyzer, "compute_fingerprint", lambda *_args: None)
    monkeypatch.setattr(
        analyzer,
        "load_audio",
        lambda *_args, **_kwargs: pytest.fail("MonoLoader path must not run"),
    )
    monkeypatch.setattr(
        analyzer,
        "validate_audio",
        lambda audio, _file_path: (
            (False, "validation sentinel")
            if audio is decoded_audio
            else pytest.fail("analyzer received different PCM")
        ),
    )

    result = analyzer.analyze("asset.audio", decoded_audio=decoded_audio)

    assert result["_error"] == "validation sentinel"


def test_decode_real_webm_opus_with_neutral_audio_extension(tmp_path: Path) -> None:
    """Regression: system ffmpeg content-probes Opus/WebM despite `.audio`."""
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        pytest.skip("ffmpeg is not installed in this test environment")
    audio_path = tmp_path / "asset.audio"
    generated = subprocess.run(  # noqa: S603 -- resolved executable, fixed test argv
        [
            ffmpeg_path,
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:a",
            "libopus",
            "-f",
            "webm",
            str(audio_path),
        ],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if generated.returncode != 0:
        pytest.skip("ffmpeg does not provide the libopus encoder")

    decoded = decode_remote_audio(str(audio_path), max_duration=1)

    assert decoded.dtype == np.float32
    assert 0 < len(decoded) <= PCM_SAMPLE_RATE
    assert np.isfinite(decoded).all()
