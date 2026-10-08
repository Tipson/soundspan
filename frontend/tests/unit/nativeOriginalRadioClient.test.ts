import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlaybackRadioOrigin } from "@soundspan/media-metadata-contract";
import {
    buildOriginalRadioContinuationPath,
    collectOriginalRadioContinuation,
} from "../../lib/radio/originalRadioContinuation";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";

const origin = { kind: "track", source: "yandex", id: "0007" } as const;
function track(provider: "vk" | "yandex", id: string) {
    return toMusicSourcePlaybackTrack({
        provider,
        id,
        title: `Song ${id}`,
        artists: ["Artist", "Guest"],
        duration: 180,
        contentVersion: "unknown",
        preview: false,
    });
}
function row(provider: "vk" | "yandex", id: string) {
    const t = track(provider, id);
    return {
        ...t,
        provider: { ...t.provider, youtubeVideoId: null, tidalTrackId: null },
        artist: { id: null, name: t.artist.name },
        album: { id: null, title: "", coverArt: null },
    };
}
test("preserves exact native original track origins and rejects native artist origins", () => {
    assert.deepEqual(
        normalizePlaybackRadioOrigin({ ...origin, token: "secret" }),
        origin,
    );
    assert.deepEqual(
        normalizePlaybackRadioOrigin({
            kind: "track",
            source: "vk",
            id: "-001_002",
        }),
        { kind: "track", source: "vk", id: "-001_002" },
    );
    for (const value of [
        { kind: "artist", source: "vk", id: "-1_2" },
        { ...origin, id: 7 },
        { ...origin, id: "vk:-1_2" },
        { ...origin, id: "7&token=secret" },
    ])
        assert.equal(normalizePlaybackRadioOrigin(value), null);
});
test("builds exact native seed and queue exclusions without signed or display metadata", () => {
    const path = buildOriginalRadioContinuationPath(
            origin,
            [
                track("yandex", "0007"),
                track("yandex", "7"),
                track("vk", "-001_002"),
            ],
            0,
            25,
            "tab",
        ),
        params = new URLSearchParams(path.split("?")[1]);
    assert.equal(params.get("type"), "yandex");
    assert.equal(params.get("value"), "0007");
    assert.equal(params.get("exclude"), "yandex:0007,yandex:7,vk:-001_002");
    assert.equal(params.get("sessionId"), "tab");
    assert.equal(params.get("cursor"), "0");
    assert.doesNotMatch(path, /Artist|Guest|token|Song|musicSourceRecording/);
});
test("collects ordered native public membership with generation, session and original station", () => {
    const response = {
        tracks: [
            row("yandex", "0007"),
            row("yandex", "8"),
            row("vk", "-001_002"),
            row("yandex", "9"),
        ],
        radioOrigin: origin,
        generationId: "generation",
        nextCursor: 1,
        degraded: false,
        degradedSources: [],
    };
    const selected = collectOriginalRadioContinuation(
        response,
        [track("yandex", "0007")],
        origin,
        25,
        "tab",
    );
    assert.deepEqual(
        selected.map((t) => t.id),
        ["yandex:8", "vk:-001_002", "yandex:9"],
    );
    for (const t of selected) {
        assert.deepEqual(t.radioOrigin, origin);
        assert.equal(t.recommendationGenerationId, "generation");
        assert.equal(t.recommendationSessionId, "tab");
        assert.equal(t.provider?.providerTrackId, t.musicSourceRecording?.id);
        assert.equal(t.mediaSource, t.musicSourceRecording?.provider);
        assert.equal(t.youtubeVideoId, undefined);
    }
    assert.deepEqual(
        collectOriginalRadioContinuation(
            response,
            [],
            { ...origin, id: "7" },
            25,
            "tab",
        ),
        [],
    );
});
test("native malformed or conflicting rows never fall through to library or YouTube", () => {
    const good = row("yandex", "8"),
        conflicts = [
            { ...good, source: "library" },
            { ...good, title: "Different" },
            { ...good, duration: 181 },
            { ...good, artist: { name: "Guest, Artist" } },
            { ...good, id: "yandex:9" },
            { ...good, provider: { source: "vk", providerTrackId: "-1_2" } },
            { ...good, youtubeVideoId: "video000001" },
            {
                ...good,
                musicSourceRecording: {
                    ...good.musicSourceRecording,
                    preview: true,
                },
            },
            {
                ...good,
                source: "youtube",
                streamSource: "youtube",
                id: "yt:video000001",
                youtubeVideoId: "video000001",
            },
        ];
    const response = {
        tracks: [...conflicts, good],
        radioOrigin: origin,
        generationId: "generation",
    };
    const selected = collectOriginalRadioContinuation(
        response,
        [],
        origin,
        25,
        "tab",
    );
    assert.deepEqual(
        selected.map((t) => t.id),
        [good.id],
    );
    assert.equal(selected[0].musicSourceRecording?.preview, false);
});
