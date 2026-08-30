import assert from "node:assert/strict";
import { test } from "node:test";

import {
    cacheRu,
    formatBackgroundAnalysisLabel,
    formatEnrichmentState,
} from "../../lib/i18n/cacheRu";

test("cache copy is Russian while technical product names remain intact", () => {
    assert.equal(cacheRu.sectionTitle, "Кэш и автоматизация");
    assert.match(cacheRu.artistDescription, /Last\.fm/);
    assert.match(cacheRu.audioDescription, /BPM/);
    assert.match(cacheRu.vibeDescription, /CLAP/);
    assert.match(cacheRu.workerDescription, /Essentia ML/);
});

test("background analysis and runtime states are localized", () => {
    assert.equal(
        formatBackgroundAnalysisLabel({ audioBusy: true, vibeBusy: true }),
        "Выполняются аудиоанализ и построение Vibe-эмбеддингов",
    );
    assert.equal(
        formatBackgroundAnalysisLabel({ audioBusy: false, vibeBusy: true }),
        "Строятся Vibe-эмбеддинги",
    );
    assert.equal(
        formatEnrichmentState({ status: "running", phase: "artists" }),
        "Обрабатываем исполнителей…",
    );
    assert.equal(
        formatEnrichmentState({ status: "stopping", currentItem: "Track A" }),
        "Останавливаемся после текущего объекта: Track A",
    );
});
