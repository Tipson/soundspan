"""Lifecycle tests for lazy DCLAP model ownership."""

from __future__ import annotations

import sys
import threading
import weakref
from collections.abc import Iterator
from types import SimpleNamespace

import model_provider
import numpy as np
import pytest
import settings
from model_provider import (
    MAX_QUEUED_INFERENCE_REQUESTS,
    DclapProvider,
    InferenceCancellation,
    InferenceCancelledError,
    ModelBundle,
)


class Clock:
    """Controllable monotonic clock."""

    def __init__(self) -> None:
        self.now = 10.0

    def __call__(self) -> float:
        """Return the current test time."""
        return self.now


class TextSession:
    """Return one fixed valid text embedding."""

    def run(self, _outputs: list[str] | None, _feed: dict[str, object]) -> list[object]:
        """Return a single ONNX-shaped vector."""
        return [np.ones((1, 512), dtype=np.float32)]


class AudioSession(TextSession):
    """Unused valid audio session fixture."""


class Tokenizer:
    """Return fixed NumPy token tensors."""

    def __call__(self, _text: str, **_kwargs: object) -> dict[str, object]:
        """Return input IDs and an attention mask."""
        return {
            "input_ids": np.ones((1, 77), dtype=np.int64),
            "attention_mask": np.ones((1, 77), dtype=np.int64),
        }


def test_first_embed_loads_lazily_then_idle_unload_reloads() -> None:
    """Load on demand, release after idle timeout, and reload on new work."""
    clock = Clock()
    load_count = 0

    def load_models() -> ModelBundle:
        nonlocal load_count
        load_count += 1
        return ModelBundle(AudioSession(), TextSession(), Tokenizer())

    provider = DclapProvider(load_models=load_models, idle_timeout=5, clock=clock)

    assert not provider.models_loaded
    assert len(provider.get_text_embedding("mellow jazz")) == 512
    assert load_count == 1
    clock.now += 6
    assert provider.unload_if_idle()
    assert not provider.models_loaded
    assert len(provider.get_text_embedding("bright pop")) == 512
    assert load_count == 2


def test_idle_timeout_zero_disables_unload() -> None:
    """Retain loaded models when idle unloading is explicitly disabled."""
    clock = Clock()
    provider = DclapProvider(
        load_models=lambda: ModelBundle(AudioSession(), TextSession(), Tokenizer()),
        idle_timeout=0,
        clock=clock,
    )
    provider.get_text_embedding("mellow jazz")
    clock.now += 3600

    assert not provider.unload_if_idle()
    assert provider.models_loaded


def test_session_options_apply_default_onnx_thread_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Set ONNX intra-op threads to the service's default cap of one."""

    class Options:
        intra_op_num_threads = 0

    fake_runtime = SimpleNamespace(SessionOptions=Options)
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_runtime)

    options = model_provider._session_options()

    assert settings.ONNX_INTRA_OP_THREADS == 1
    assert isinstance(options, Options)
    assert options.intra_op_num_threads == 1


def test_cancelled_audio_stops_between_segments_and_releases_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop before the next ONNX batch and leave serialized inference usable."""
    first_segment_started = threading.Event()
    release_first_segment = threading.Event()

    class BlockingAudioSession(AudioSession):
        def run(
            self,
            _outputs: list[str] | None,
            _feed: dict[str, object],
        ) -> list[object]:
            first_segment_started.set()
            assert release_first_segment.wait(timeout=1)
            return [np.ones((1, 512), dtype=np.float32)]

    monkeypatch.setattr(
        model_provider,
        "load_audio",
        lambda _path, **_kwargs: object(),
    )
    monkeypatch.setattr(
        model_provider,
        "segmented_log_mels",
        lambda _decoded, **_kwargs: (item for item in [object(), object()]),
    )
    provider = DclapProvider(
        load_models=lambda: ModelBundle(
            BlockingAudioSession(),
            TextSession(),
            Tokenizer(),
        ),
        idle_timeout=0,
    )
    cancellation = InferenceCancellation(deadline=None)
    errors: list[BaseException] = []

    def embed_audio() -> None:
        try:
            provider.get_audio_embedding("track.flac", cancellation)
        except BaseException as error:
            errors.append(error)

    worker = threading.Thread(target=embed_audio)
    worker.start()
    assert first_segment_started.wait(timeout=1)
    cancellation.cancel()
    release_first_segment.set()
    worker.join(timeout=1)

    assert not worker.is_alive()
    assert len(errors) == 1
    assert isinstance(errors[0], InferenceCancelledError)
    assert (
        len(
            provider.get_text_embedding(
                "lock remains usable",
                InferenceCancellation(deadline=None),
            )
        )
        == 512
    )


def test_blocking_audio_decode_does_not_hold_inference_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Allow text inference while an audio request remains blocked in decode."""
    decode_started = threading.Event()
    release_decode = threading.Event()
    text_finished = threading.Event()

    def blocking_decoder(
        _path: str,
        check_cancelled: object | None = None,
    ) -> object:
        del check_cancelled
        decode_started.set()
        assert release_decode.wait(timeout=1)
        return object()

    monkeypatch.setattr(model_provider, "load_audio", blocking_decoder)
    monkeypatch.setattr(
        model_provider,
        "segmented_log_mels",
        lambda _decoded, **_kwargs: (item for item in [object()]),
    )
    provider = DclapProvider(
        load_models=lambda: ModelBundle(AudioSession(), TextSession(), Tokenizer()),
        idle_timeout=0,
    )
    audio = threading.Thread(
        target=provider.get_audio_embedding,
        args=("track.flac", InferenceCancellation(deadline=None)),
    )

    def embed_text() -> None:
        provider.get_text_embedding(
            "decode must not own lock",
            InferenceCancellation(deadline=None),
        )
        text_finished.set()

    text = threading.Thread(target=embed_text)
    audio.start()
    assert decode_started.wait(timeout=1)
    text.start()
    completed_before_decode = text_finished.wait(timeout=0.25)
    release_decode.set()
    audio.join(timeout=1)
    text.join(timeout=1)

    assert completed_before_decode
    assert not audio.is_alive()
    assert not text.is_alive()


def test_mel_generator_is_consumed_lazily_during_inference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not materialize every mel tensor before the first ONNX call."""
    events: list[str] = []

    def decoded_audio(_path: str, **_kwargs: object) -> object:
        return object()

    def instrumented_mels(_source: object, **_kwargs: object) -> Iterator[object]:
        def generate() -> Iterator[object]:
            events.append("first")
            yield object()
            events.append("second")
            yield object()
            events.append("exhausted")

        return generate()

    class InspectingAudioSession(AudioSession):
        def run(
            self,
            _outputs: list[str] | None,
            _feed: dict[str, object],
        ) -> list[object]:
            assert "exhausted" not in events
            return [np.ones((1, 512), dtype=np.float32)]

    monkeypatch.setattr(model_provider, "load_audio", decoded_audio)
    monkeypatch.setattr(
        model_provider,
        "segmented_log_mels",
        instrumented_mels,
    )
    provider = DclapProvider(
        load_models=lambda: ModelBundle(
            InspectingAudioSession(),
            TextSession(),
            Tokenizer(),
        ),
        idle_timeout=0,
    )

    provider.get_audio_embedding("track.flac", InferenceCancellation(deadline=None))

    assert events == ["first", "second", "exhausted"]


def test_admission_reservation_rejects_before_executor_submission() -> None:
    """Expose a non-blocking capacity reservation for the HTTP boundary."""
    provider = DclapProvider(
        load_models=lambda: ModelBundle(AudioSession(), TextSession(), Tokenizer()),
        idle_timeout=0,
        max_queued_requests=0,
    )

    assert provider.try_reserve_inference()
    assert not provider.try_reserve_inference()
    provider.release_inference()
    assert provider.try_reserve_inference()
    provider.release_inference()
    assert MAX_QUEUED_INFERENCE_REQUESTS == 4


def test_queued_audio_does_not_retain_another_decoded_waveform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep one audio buffer resident through decode, lock wait and inference."""
    first_running = threading.Event()
    release_first = threading.Event()
    second_decoded = threading.Event()
    errors: list[BaseException] = []

    def decode(path: str, **_kwargs: object) -> object:
        if path == "second.flac":
            second_decoded.set()
        return object()

    class BlockingSession(AudioSession):
        def run(self, outputs: list[str] | None, feed: dict[str, object]) -> list[object]:
            first_running.set()
            assert release_first.wait(timeout=3)
            return super().run(outputs, feed)

    monkeypatch.setattr(model_provider, "load_audio", decode)
    monkeypatch.setattr(
        model_provider,
        "segmented_log_mels",
        lambda *_args, **_kwargs: (item for item in [object()]),
    )
    provider = DclapProvider(
        load_models=lambda: ModelBundle(BlockingSession(), TextSession(), Tokenizer()),
        idle_timeout=0,
    )

    def embed(path: str) -> None:
        try:
            provider.get_audio_embedding(path)
        except BaseException as error:
            errors.append(error)

    first = threading.Thread(target=embed, args=("first.flac",))
    second = threading.Thread(target=embed, args=("second.flac",))
    first.start()
    try:
        assert first_running.wait(timeout=2)
        second.start()
        decoded_while_first_running = second_decoded.wait(timeout=0.3)
    finally:
        release_first.set()
        first.join(timeout=3)
        if second.ident is not None:
            second.join(timeout=3)
    assert not first.is_alive() and not second.is_alive()
    assert not errors
    assert not decoded_while_first_running
    assert second_decoded.is_set()


@pytest.mark.parametrize("failure", ["decode", "cancel", "inference"])
def test_audio_buffer_slot_is_released_after_failure(
    monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    """A failed or cancelled request must not starve the next audio request."""
    control = InferenceCancellation(deadline=None)

    def decode(_path: str, **_kwargs: object) -> object:
        if failure == "decode":
            raise RuntimeError("decode failed")
        if failure == "cancel":
            control.cancel()
        return object()

    class FailingSession(AudioSession):
        def run(self, outputs: list[str] | None, feed: dict[str, object]) -> list[object]:
            raise RuntimeError("inference failed")

    provider = DclapProvider(
        load_models=lambda: ModelBundle(FailingSession(), TextSession(), Tokenizer()),
        idle_timeout=0,
    )
    monkeypatch.setattr(model_provider, "load_audio", decode)
    monkeypatch.setattr(
        model_provider,
        "segmented_log_mels",
        lambda *_args, **_kwargs: (item for item in [object()]),
    )
    with pytest.raises(RuntimeError):
        provider.get_audio_embedding("broken.flac", control)
    monkeypatch.setattr(model_provider, "load_audio", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(model_provider, "run_audio_chunks", lambda *_args: [1.0] * 512)
    # Bound a regression rather than hanging the test for the production wait budget.
    monkeypatch.setattr(model_provider, "MAX_INFERENCE_LOCK_POLLS", 2)
    assert len(provider.get_audio_embedding("valid.flac")) == 512


def test_cancelled_traceback_does_not_retain_decoded_audio(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even a retained failed future must not keep the large waveform alive."""
    control = InferenceCancellation(deadline=None)
    references: list[weakref.ReferenceType[object]] = []

    class Waveform:
        pass

    def decode(_path: str, **_kwargs: object) -> object:
        waveform = Waveform()
        references.append(weakref.ref(waveform))
        return waveform

    def mels(source: object, **_kwargs: object) -> Iterator[object]:
        yield object()
        assert source is not None

    class CancellingSession(AudioSession):
        def run(self, outputs: list[str] | None, feed: dict[str, object]) -> list[object]:
            control.cancel()
            return super().run(outputs, feed)

    provider = DclapProvider(
        load_models=lambda: ModelBundle(CancellingSession(), TextSession(), Tokenizer()),
        idle_timeout=0,
    )
    monkeypatch.setattr(model_provider, "load_audio", decode)
    monkeypatch.setattr(model_provider, "segmented_log_mels", mels)
    with pytest.raises(InferenceCancelledError) as failure:
        provider.get_audio_embedding("cancelled.flac", control)
    assert failure.value.__traceback__ is not None
    assert len(references) == 1
    assert references[0]() is None
