"""Safely decode canonical remote-analysis assets with the system FFmpeg runtime."""

from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any, Protocol
from uuid import UUID

import numpy as np

from services.common.logging_utils import configure_service_logger

PCM_SAMPLE_RATE = 44_100
MAX_REMOTE_DECODE_SECONDS = 90
_PCM_DTYPE = np.dtype("<f4")
_FFMPEG_TIMEOUT_SECONDS = 120.0
_OWNED_SPOOL_DIRECTORY = ".soundspan-analysis-spool"
logger = configure_service_logger("audio-analyzer").getChild("RemoteAudioDecode")


class RemoteAudioDecodeError(RuntimeError):
    """Represent a bounded, operator-safe remote audio decoding failure."""


class Analyzer(Protocol):
    """Audio-analysis operation required after optional remote decoding."""

    def analyze(
        self,
        file_path: str,
        *,
        decoded_audio: Any | None = None,
    ) -> dict[str, Any]:
        """Analyze one resolved library path with optional predecoded PCM."""


def is_remote_analysis_audio_reference(file_path: str) -> bool:
    """Recognize the exact direct-child UUID asset form emitted by the backend."""
    if "\\" in file_path or "\x00" in file_path:
        return False
    reference = PurePosixPath(file_path)
    if (
        reference.is_absolute()
        or len(reference.parts) != 2
        or reference.parts[0] != _OWNED_SPOOL_DIRECTORY
    ):
        return False
    file_name = reference.parts[1]
    if not file_name.endswith(".audio"):
        return False
    identifier = file_name.removesuffix(".audio")
    try:
        parsed_identifier = UUID(identifier)
    except ValueError:
        return False
    return str(parsed_identifier) == identifier


def analyze_audio_reference(
    analyzer: Analyzer,
    file_reference: str,
    resolved_path: str,
    *,
    max_duration: int,
    batch_timeout_seconds: int,
) -> dict[str, Any]:
    """Analyze ordinary library audio or safely predecode one generated remote asset."""
    if not is_remote_analysis_audio_reference(file_reference):
        return analyzer.analyze(resolved_path)
    try:
        decoded_audio = decode_remote_audio(
            resolved_path,
            max_duration=max_duration,
            timeout_seconds=_decoder_timeout_for_batch(batch_timeout_seconds),
        )
    except RemoteAudioDecodeError as error:
        logger.error("Remote canonical audio decode failed: %s", error)
        return {"_error": str(error), "_permanent": True}
    except Exception as error:
        logger.error("Unexpected remote canonical audio decode failure: %s", type(error).__name__)
        return {"_error": "Remote audio decode failed unexpectedly", "_permanent": True}
    return analyzer.analyze(resolved_path, decoded_audio=decoded_audio)


def decode_remote_audio(
    file_path: str,
    *,
    max_duration: int,
    timeout_seconds: float = _FFMPEG_TIMEOUT_SECONDS,
) -> Any:
    """Decode bounded mono 44.1 kHz float32 PCM without invoking Essentia's decoder."""
    duration = _bounded_duration(max_duration)
    timeout = _bounded_timeout(timeout_seconds)
    ffmpeg_path = _resolve_ffmpeg_executable()
    try:
        resolved_audio_path = Path(file_path).resolve(strict=True)
    except OSError as error:
        raise RemoteAudioDecodeError("Remote audio asset is unavailable") from error
    if not resolved_audio_path.is_file():
        raise RemoteAudioDecodeError("Remote audio asset is unavailable")

    output_limit = duration * PCM_SAMPLE_RATE * _PCM_DTYPE.itemsize
    command = [
        ffmpeg_path,
        "-nostdin",
        "-v",
        "error",
        "-i",
        str(resolved_audio_path),
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        str(duration),
        "-ac",
        "1",
        "-ar",
        str(PCM_SAMPLE_RATE),
        "-c:a",
        "pcm_f32le",
        "-f",
        "f32le",
        "-fs",
        str(output_limit),
        "pipe:1",
    ]
    try:
        completed = subprocess.run(  # noqa: S603 -- absolute trusted executable, argv only
            command,
            check=False,
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        # subprocess.run kills and waits for its direct child before raising.
        raise RemoteAudioDecodeError("Remote audio decode timed out") from error
    except OSError as error:
        raise RemoteAudioDecodeError("System audio decoder is unavailable") from error

    if completed.returncode != 0:
        raise RemoteAudioDecodeError("Remote audio decode failed")
    pcm_bytes = completed.stdout
    if not isinstance(pcm_bytes, bytes):
        raise RemoteAudioDecodeError("Remote audio decoder returned invalid PCM")
    if len(pcm_bytes) > output_limit:
        raise RemoteAudioDecodeError("Remote audio decoder exceeded output limit")
    if not pcm_bytes:
        raise RemoteAudioDecodeError("Remote audio decoder returned no samples")
    if len(pcm_bytes) % _PCM_DTYPE.itemsize != 0:
        raise RemoteAudioDecodeError("Remote audio decoder returned invalid PCM")

    decoded = np.frombuffer(pcm_bytes, dtype=_PCM_DTYPE).astype(np.float32, copy=True)
    if decoded.size == 0 or not np.isfinite(decoded).all():
        raise RemoteAudioDecodeError("Remote audio decoder returned invalid PCM")
    return decoded


def _bounded_duration(max_duration: int) -> int:
    """Return a positive duration within the remote decode hard limit."""
    if isinstance(max_duration, bool) or not isinstance(max_duration, int) or max_duration <= 0:
        raise RemoteAudioDecodeError("Remote audio decode duration is invalid")
    return min(max_duration, MAX_REMOTE_DECODE_SECONDS)


def _bounded_timeout(timeout_seconds: float) -> float:
    """Return a positive decoder timeout within the hard runtime limit."""
    if (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or not math.isfinite(timeout_seconds)
        or timeout_seconds <= 0
    ):
        raise RemoteAudioDecodeError("Remote audio decode timeout is invalid")
    return min(float(timeout_seconds), _FFMPEG_TIMEOUT_SECONDS)


def _decoder_timeout_for_batch(batch_timeout_seconds: int) -> float:
    """Finish or kill FFmpeg before the owning process pool reaches its deadline."""
    if (
        isinstance(batch_timeout_seconds, bool)
        or not isinstance(batch_timeout_seconds, int)
        or batch_timeout_seconds <= 0
    ):
        raise RemoteAudioDecodeError("Analysis batch timeout is invalid")
    return min(_FFMPEG_TIMEOUT_SECONDS, batch_timeout_seconds / 2.0)


def _resolve_ffmpeg_executable() -> str:
    """Resolve the image-provided FFmpeg executable before constructing argv."""
    executable = shutil.which("ffmpeg")
    if executable is None:
        raise RemoteAudioDecodeError("System audio decoder is unavailable")
    try:
        resolved = Path(executable).resolve(strict=True)
    except OSError as error:
        raise RemoteAudioDecodeError("System audio decoder is unavailable") from error
    if not resolved.is_file():
        raise RemoteAudioDecodeError("System audio decoder is unavailable")
    return str(resolved)
