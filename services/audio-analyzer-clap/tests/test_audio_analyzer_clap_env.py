import os
from pathlib import Path

import pytest

from services.common.analyzer_env import (
    configure_thread_env,
    get_blocking_socket_timeout,
    get_int_env,
)


THREAD_ENV_KEYS = [
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_MAX_THREADS",
]
TF_ENV_KEYS = [
    "TF_CPP_MIN_LOG_LEVEL",
    "TF_NUM_INTRAOP_THREADS",
    "TF_NUM_INTEROP_THREADS",
]
ANALYZER_PATH = Path(__file__).resolve().parents[1] / "analyzer.py"


def test_get_int_env_reads_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MVR12_TEST_OVERRIDE_INT", "9")
    assert get_int_env("MVR12_TEST_OVERRIDE_INT", 1) == 9


def test_blocking_socket_timeout_default_exceeds_block_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CLAP_REDIS_SOCKET_TIMEOUT", raising=False)

    timeout = get_blocking_socket_timeout(
        "CLAP_REDIS_SOCKET_TIMEOUT",
        default=10,
        blocking_timeout=5,
    )

    assert timeout == 10
    assert timeout > 5


def test_blocking_socket_timeout_honors_safe_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLAP_REDIS_SOCKET_TIMEOUT", "17")

    timeout = get_blocking_socket_timeout(
        "CLAP_REDIS_SOCKET_TIMEOUT",
        default=10,
        blocking_timeout=5,
    )

    assert timeout == 17
    assert timeout > 5


def test_blocking_socket_timeout_clamps_unsafe_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLAP_REDIS_SOCKET_TIMEOUT", "5")

    timeout = get_blocking_socket_timeout(
        "CLAP_REDIS_SOCKET_TIMEOUT",
        default=10,
        blocking_timeout=5,
    )

    assert timeout == 10
    assert timeout > 5


def test_blocking_socket_timeout_rejects_non_positive_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLAP_REDIS_SOCKET_TIMEOUT", "0")

    with pytest.raises(ValueError, match="must be positive"):
        get_blocking_socket_timeout(
            "CLAP_REDIS_SOCKET_TIMEOUT",
            default=10,
            blocking_timeout=5,
        )


def test_worker_applies_bounded_socket_timeout_to_queue_client() -> None:
    source = ANALYZER_PATH.read_text(encoding="utf-8")

    assert "'CLAP_REDIS_SOCKET_TIMEOUT'" in source
    assert "socket_timeout=REDIS_SOCKET_TIMEOUT" in source


def test_configure_thread_env_without_tensorflow_sets_only_blas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in THREAD_ENV_KEYS + TF_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)

    configure_thread_env(threads_per_worker=2, configure_tensorflow=False)

    for key in THREAD_ENV_KEYS:
        assert os.environ[key] == "2"

    for key in TF_ENV_KEYS:
        assert key not in os.environ
