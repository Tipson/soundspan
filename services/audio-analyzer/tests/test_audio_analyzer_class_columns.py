"""Behavioral coverage for MusiCNN classification-head column selection."""

from typing import Any

import numpy as np
import pytest
from test_audio_analyzer_env import _load_analyzer_with_recording_redis


@pytest.fixture
def analyzer_module(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Load the analyzer with the lightweight dependency stubs used by env tests."""
    return _load_analyzer_with_recording_redis(monkeypatch, [], [])


def test_ml_features_select_each_heads_positive_class_column(analyzer_module: Any) -> None:
    """Use each model metadata contract's positive probability column."""
    analyzer = analyzer_module.AudioAnalyzer()
    analyzer.musicnn_model = lambda _audio: np.array([[1.0]], dtype=np.float32)

    def predictions(_embeddings: np.ndarray) -> np.ndarray:
        return np.array([[0.1, 0.9], [0.3, 0.7]], dtype=np.float32)

    model_names = (
        "mood_aggressive",
        "mood_happy",
        "mood_acoustic",
        "mood_electronic",
        "danceability",
        "voice_instrumental",
        "mood_sad",
        "mood_relaxed",
        "mood_party",
    )
    analyzer.prediction_models = dict.fromkeys(model_names, predictions)

    result = analyzer._extract_ml_features(np.array([0.0], dtype=np.float32))

    column_zero_outputs = (
        "moodAggressive",
        "moodHappy",
        "moodAcoustic",
        "moodElectronic",
        "danceabilityMl",
        "instrumentalness",
    )
    column_one_outputs = ("moodSad", "moodRelaxed", "moodParty")

    assert all(result[name] == pytest.approx(0.2) for name in column_zero_outputs)
    assert all(result[name] == pytest.approx(0.8) for name in column_one_outputs)
