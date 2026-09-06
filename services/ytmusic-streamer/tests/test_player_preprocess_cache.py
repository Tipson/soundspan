"""Bounded public-player reuse never caches a listener's challenge responses."""

import json
from concurrent.futures import ThreadPoolExecutor

import pytest


def test_byte_budget_lru_expiration_and_oversize() -> None:
    from ytmusic_player_cache import PlayerCache

    clock = [0.0]
    cache = PlayerCache(max_bytes=8, max_entries=2, ttl=10, clock=lambda: clock[0])
    cache.put("a", b"1234")
    cache.put("b", b"5678")
    assert cache.get("a") == b"1234"
    cache.put("c", b"abcd")
    assert cache.get("b") is None
    cache.put("oversize", b"123456789")
    assert cache.get("oversize") is None
    assert cache.byte_size == 8
    clock[0] = 11
    assert cache.get("a") is None
    assert cache.byte_size == 0


def test_parallel_cache_operations_stay_bounded() -> None:
    from ytmusic_player_cache import PlayerCache

    cache = PlayerCache(max_bytes=64, max_entries=4, ttl=10)

    def write(index: int) -> None:
        cache.put(str(index), b"a" * 16)
        cache.get(str(index))

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(write, range(100)))
    assert cache.byte_size <= 64


@pytest.fixture
def solver(monkeypatch: pytest.MonkeyPatch):
    import ytmusic_player_cache as module

    calls = []
    cache = module.PlayerCache(max_bytes=1024, max_entries=2, ttl=10)
    monkeypatch.setattr(module, "_player_cache", cache)

    def construct(_self, player, preprocessed, requests):
        return json.dumps({"player": player, "prepared": preprocessed, "requests": requests})

    def run(_self, stdin):
        data = json.loads(stdin)
        calls.append(data)
        return json.dumps(
            {
                "type": "result",
                "preprocessed_player": {"code": data["player"]},
                "responses": [{"type": "result", "data": data["requests"]}],
            }
        )

    monkeypatch.setattr(module.DenoJCP, "_construct_stdin", construct)
    monkeypatch.setattr(module.DenoJCP, "_run_js_runtime", run)

    def invoke(player, requests):
        instance = object.__new__(module.SoundspanDenoJCP)
        stdin = instance._construct_stdin(player, False, requests)
        return json.loads(instance._run_js_runtime(stdin))

    return module, calls, invoke


def test_new_instance_reuses_only_code_not_previous_requests(solver) -> None:
    _module, calls, invoke = solver
    invoke("public-script-a", ["listener-one"])
    result = invoke("public-script-a", ["listener-two"])
    assert [call["prepared"] for call in calls] == [False, True]
    assert calls[1]["player"] == {"code": "public-script-a"}
    assert result["responses"][0]["data"] == ["listener-two"]
    invoke("public-script-b", ["listener-three"])
    assert calls[-1]["prepared"] is False


@pytest.mark.parametrize("failure", ["exception", "malformed", "response-error"])
def test_bad_cached_processing_retries_original_once(solver, monkeypatch, failure) -> None:
    module, calls, invoke = solver
    invoke("public-script", ["first"])
    original_run = module.DenoJCP._run_js_runtime

    def fail_cached(self, stdin):
        if json.loads(stdin)["prepared"]:
            if failure == "exception":
                raise RuntimeError("cached processing failed")
            if failure == "malformed":
                return "not json"
            return json.dumps({"type": "result", "responses": [{"type": "error"}]})
        return original_run(self, stdin)

    monkeypatch.setattr(module.DenoJCP, "_run_js_runtime", fail_cached)
    result = invoke("public-script", ["second"])
    assert result["responses"][0]["data"] == ["second"]
    assert len(calls) == 2
    assert calls[-1]["prepared"] is False


def test_failed_fresh_processing_is_not_cached(solver, monkeypatch) -> None:
    module, _calls, invoke = solver
    monkeypatch.setattr(module.DenoJCP, "_run_js_runtime", lambda *_args: '{"type":"error"}')
    assert invoke("public-script", ["first"])["type"] == "error"
    assert module._player_cache.byte_size == 0
