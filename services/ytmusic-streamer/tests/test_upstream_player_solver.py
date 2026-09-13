"""Extraction must keep the upstream solver after the live cross-track 403 regression."""

from concurrent.futures import ThreadPoolExecutor

import pytest


@pytest.mark.parametrize("concurrent", [False, True])
def test_bootstrap_preserves_upstream_solver_registry(
    monkeypatch: pytest.MonkeyPatch, concurrent: bool
) -> None:
    import ytmusic_player_cache as module
    from yt_dlp.extractor.youtube.jsc import _registry

    # Scope the registry so a failing bootstrap cannot leak into other tests.
    providers = dict(_registry._jsc_providers.value)
    preferences = set(_registry._jsc_preferences.value)
    monkeypatch.setattr(_registry._jsc_providers, "value", dict(providers))
    monkeypatch.setattr(_registry._jsc_preferences, "value", set(preferences))
    monkeypatch.setattr(module, "_registered", False, raising=False)
    if concurrent:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: module.register_player_cache(), range(12)))
    else:
        results = [module.register_player_cache(), module.register_player_cache()]

    assert not any(results), "Unvalidated preprocessing must not replace the upstream solver"
    assert _registry._jsc_providers.value == providers
    assert _registry._jsc_preferences.value == preferences
