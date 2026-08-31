import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surfaceFiles = {
    queue: "../../app/queue/page.tsx",
    radio: "../../app/radio/page.tsx",
    history: "../../app/my-history/page.tsx",
    playlists: "../../app/playlists/page.tsx",
    import: "../../app/import/page.tsx",
    device: "../../app/device/page.tsx",
} as const;

const surfaceSources = Object.fromEntries(
    Object.entries(surfaceFiles).map(([surface, path]) => [
        surface,
        readFileSync(new URL(path, import.meta.url), "utf8"),
    ]),
) as Record<keyof typeof surfaceFiles, string>;

test("secondary consumer routes share one open Spectral Stage presentation", () => {
    for (const [surface, source] of Object.entries(surfaceSources)) {
        assert.match(
            source,
            new RegExp(`data-consumer-surface=["']${surface}["']`),
            surface,
        );
        assert.match(source, /<PageHeader/, surface);
        assert.doesNotMatch(source, /<Card\b/, surface);
        assert.doesNotMatch(
            source,
            /overflow-x-(?:auto|scroll)/,
            `${surface}: no route-level horizontal scroller`,
        );
    }
});

test("secondary consumer routes use semantic tokens instead of legacy raw colors", () => {
    const sources = [
        ...Object.values(surfaceSources),
        readFileSync(
            new URL("../../app/radio/RadioStationMosaic.tsx", import.meta.url),
            "utf8",
        ),
        readFileSync(
            new URL(
                "../../components/ui/RadioStationCard.tsx",
                import.meta.url,
            ),
            "utf8",
        ),
    ].join("\n");

    for (const legacyColor of [
        "bg-[#111]",
        "#60a5fa",
        "#1DB954",
        "#00BFFF",
        "#1f2937",
        "#111827",
    ]) {
        assert.equal(sources.includes(legacyColor), false, legacyColor);
    }
});

test("route-level waits use the shared Russian loading presentation", () => {
    const loadingSources = [
        readFileSync(
            new URL("../../app/queue/loading.tsx", import.meta.url),
            "utf8",
        ),
        readFileSync(
            new URL("../../app/playlists/loading.tsx", import.meta.url),
            "utf8",
        ),
        surfaceSources.history,
        surfaceSources.playlists,
        surfaceSources.import,
        surfaceSources.device,
    ];

    for (const source of loadingSources) {
        assert.match(source, /<LoadingScreen/);
        assert.match(source, /message=["'][^"']*[А-Яа-яЁё]/);
    }
});
