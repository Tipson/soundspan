import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    persistWaveSelection,
    readWaveSelection,
    readPersistedWaveSelection,
    replaceWaveSelection,
    waveSelectionStorageKey,
} from "@/lib/waveSelection";
import { queryKeys } from "@/lib/queryKeys";
import {
    buildPersonalizedHomeFeedUrl,
    waveLanguageRefreshInterval,
} from "@/features/home/hooks/usePersonalizedHomeFeed";
import { buildProviderRadioContinuationPath } from "@/lib/audio/providerRadioContinuation";

GlobalRegistrator.register({ url: "https://soundspan.test/vibe" });
after(() => GlobalRegistrator.unregister());
test("retired language restrictions are ignored without losing direction or mood", () => {
    window.localStorage.setItem(
        waveSelectionStorageKey("one"),
        JSON.stringify({ mode: "new", mood: "focus", language: "ru" }),
    );
    assert.deepEqual(readPersistedWaveSelection("one"), {
        mode: "new",
        mood: "focus",
        language: "any",
    });
    assert.equal(readPersistedWaveSelection("two").language, "any");
    window.history.replaceState({ overlay: true }, "", "/vibe?mode=familiar");
    assert.equal(readWaveSelection("one").language, "any");
    replaceWaveSelection("new", "focus", "foreign");
    assert.equal(readWaveSelection("one").language, "any");
    assert.equal(
        new URL(window.location.href).searchParams.has("language"),
        false,
    );
    assert.deepEqual(window.history.state, { overlay: true });
    window.history.replaceState(null, "", "/vibe?language=ru");
    assert.equal(readWaveSelection("one").language, "any");
    persistWaveSelection("one", "new", "focus", "ru");
    assert.equal(
        JSON.parse(window.localStorage.getItem(waveSelectionStorageKey("one"))!)
            .language,
        "any",
    );
});
test("each language has a separate cache and travels with the original mood and direction", () => {
    assert.notDeepEqual(
        queryKeys.personalizedHome(25, "new", "focus", "wave", "ru"),
        queryKeys.personalizedHome(25, "new", "focus", "wave", "foreign"),
    );
    for (const path of [
        buildPersonalizedHomeFeedUrl(
            25,
            "new",
            "focus",
            "wave",
            "session",
            null,
            "ru",
        ),
        buildProviderRadioContinuationPath(
            [],
            1,
            25,
            "new",
            "focus",
            null,
            "ru",
        ),
    ]) {
        const params = new URL(path, "https://soundspan.test").searchParams;
        assert.equal(params.get("language"), "ru");
        assert.equal(params.get("mode"), "new");
        assert.equal(params.get("mood"), "focus");
    }
});

test("language preparation refresh is bounded and never polls a ready queue or Any", () => {
    const empty = {
        shelves: { quickPicks: [], discovery: [], listenAgain: [] },
        languageStatus: {
            selection: "ru" as const,
            pending: true,
            classified: 0,
            total: 20,
        },
        degraded: false,
        reason: null,
        seedCount: 3,
    };
    assert.equal(waveLanguageRefreshInterval("ru", empty, 1), 5000);
    assert.equal(waveLanguageRefreshInterval("ru", empty, 6), false);
    assert.equal(waveLanguageRefreshInterval("any", empty, 1), false);
    assert.equal(
        waveLanguageRefreshInterval(
            "ru",
            {
                ...empty,
                languageStatus: { ...empty.languageStatus, pending: false },
            },
            1,
        ),
        false,
    );
    assert.equal(
        waveLanguageRefreshInterval(
            "ru",
            {
                ...empty,
                shelves: { ...empty.shelves, quickPicks: [{} as never] },
            },
            1,
        ),
        false,
    );
});
