import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
    formatAnalysisCoverageSummaryRu,
    formatDuplicatesSummaryRu,
    formatMetadataGapsSummaryRu,
    formatPendingRequestsRu,
    formatCollectionLikedRu,
    formatCollectionPreferencesClearedRu,
    formatQualitySummaryRu,
    formatReleaseCalendarDateRu,
    formatReleaseRadarSummaryRu,
    formatRelativeReleaseDateRu,
    formatRequestDateRu,
    formatShowingRu,
    formatStorageSummaryRu,
    libraryOperationsRu,
    requestFilterLabelRu,
    requestStatusLabelRu,
} from "@/lib/i18n/libraryOperationsRu";

test("library insights summaries use correct Russian noun forms", () => {
    assert.equal(
        formatMetadataGapsSummaryRu(1, 2, 4, 11),
        "1 альбом без обложки · 2 альбома без MBID · 4 трека без жанров · 11 треков без текста",
    );
    assert.equal(
        formatAnalysisCoverageSummaryRu("93%", "90%", "75%", 4),
        "Аудио 93% · Vibe 90% · Громкость 75% · 4 ошибки",
    );
    assert.equal(
        formatDuplicatesSummaryRu(9, 5, 3, 1),
        "9 групп · 5 точных совпадений · 3 одинаковые записи · 1 совпадение ISRC",
    );
    assert.equal(
        formatStorageSummaryRu(200, "5.0 GB", 3),
        "200 треков · 5.0 GB · 3 формата",
    );
    assert.equal(
        formatQualitySummaryRu(6, 192),
        "6 альбомов с потерями ниже 192 kbps",
    );
    assert.equal(
        formatShowingRu(8, 11, ["трек", "трека", "треков"]),
        "Показано 8 из 11 треков.",
    );
});

test("release copy preserves calendar behavior while localizing dates and counts", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    assert.equal(
        formatRelativeReleaseDateRu("2026-08-31T12:00:00.000Z", now),
        "Завтра",
    );
    assert.equal(
        formatRelativeReleaseDateRu("2026-09-02T12:00:00.000Z", now),
        "Через 3 дня",
    );
    assert.equal(
        formatRelativeReleaseDateRu("2026-08-28T12:00:00.000Z", now),
        "2 дня назад",
    );
    assert.match(
        formatReleaseCalendarDateRu("2026-08-20T12:00:00.000Z"),
        /20 авг\. 2026 г\./,
    );
    assert.equal(
        formatReleaseRadarSummaryRu(21, 3, 12),
        "21 отслеживаемый исполнитель • 3 будущих релиза • 12 недавних релизов",
    );
});

test("request filters, statuses and dates never expose raw English fallbacks", () => {
    assert.equal(requestFilterLabelRu("all"), "Все");
    assert.equal(requestFilterLabelRu("fulfilled"), "В коллекции");
    assert.equal(requestStatusLabelRu("pending"), "Ожидает");
    assert.equal(requestStatusLabelRu("mystery"), "Неизвестный статус");
    assert.equal(formatPendingRequestsRu(1), "1 на рассмотрении");
    assert.match(
        formatRequestDateRu("2026-08-20T12:00:00.000Z"),
        /20 авг\. 2026 г\./,
    );
    assert.equal(formatRequestDateRu("not-a-date"), "");
});

test("collection preference feedback uses Russian count forms", () => {
    assert.equal(formatCollectionLikedRu(1), "Понравился 1 трек");
    assert.equal(formatCollectionLikedRu(24), "Понравились 24 трека");
    assert.equal(
        formatCollectionPreferencesClearedRu(1),
        "Отметка очищена у 1 трека",
    );
    assert.equal(
        formatCollectionPreferencesClearedRu(12),
        "Отметки очищены у 12 треков",
    );
});

test("target pages do not retain direct English UI literals", () => {
    const files = [
        "features/library-health/components/AnalysisCoveragePanel.tsx",
        "features/library-health/components/DuplicatesPanel.tsx",
        "features/library-health/components/InsightPanel.tsx",
        "features/library-health/components/LibraryInsightsSection.tsx",
        "features/library-health/components/MetadataGapsPanel.tsx",
        "features/library-health/components/QualityPanel.tsx",
        "features/library-health/components/StoragePanel.tsx",
        "features/library-health/hooks/useLibraryInsights.ts",
        "app/releases/page.tsx",
        "app/requests/page.tsx",
    ].map((path) => readFileSync(path, "utf8"));
    const source = files.join("\n");
    const forbidden = [
        'title="Library Insights"',
        'title="Analysis coverage"',
        'title="Metadata gaps"',
        'title="Duplicates and versions"',
        'title="Quality outliers"',
        'title="Storage"',
        'label: "Cover art"',
        'aria-label="Request status filter"',
        '"Failed to load releases"',
        '"No releases found"',
        '"Request this release"',
        '"Something went wrong"',
    ];
    for (const literal of forbidden) {
        assert.equal(source.includes(literal), false, literal);
    }
    assert.match(libraryOperationsRu.libraryInsights.title, /[А-Яа-яЁё]/);
    assert.match(libraryOperationsRu.releases.title, /[А-Яа-яЁё]/);
    assert.match(libraryOperationsRu.requests.title, /[А-Яа-яЁё]/);
});
