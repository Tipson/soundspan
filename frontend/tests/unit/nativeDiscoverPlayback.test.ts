import assert from "node:assert/strict";
import test from "node:test";
import { mapDiscoverTrackToPlaybackTrack } from "../../features/discover/hooks/useDiscoverActions";
import { applyDiscoverProviderGapFill } from "../../features/discover/hooks/useDiscoverProviderGapFill";
import type { DiscoverTrack } from "../../features/discover/types";
import type { Track } from "../../lib/audio-state-context";

function native(provider: "vk" | "yandex"): DiscoverTrack {
    const id = provider === "vk" ? "-01_0002" : "0007";
    return {
        id: `${provider}:${id}`,
        title: "Exact song",
        artist: "Second, First",
        album: "Album",
        albumId: "",
        duration: 180,
        sourceType: provider,
        streamSource: provider,
        provider: { source: provider, providerTrackId: id },
        musicSourceRecording: {
            provider,
            id,
            title: "Exact song",
            artists: ["Second", "First"],
            duration: 180,
            contentVersion: "clean",
            preview: false,
            streamUrl: "https://secret.invalid/stream",
        },
        recommendationGenerationId: "weekly-generation",
        isLiked: false,
        likedAt: null,
        similarity: 1,
        tier: "high",
        coverUrl: null,
        available: false,
    } as unknown as DiscoverTrack;
}

for (const provider of ["vk", "yandex"] as const) {
    test(`${provider} Discover mapping preserves exact namespace, ordered clean recording and finite lineage`, () => {
        const mapped = mapDiscoverTrackToPlaybackTrack(
            native(provider),
        ) as Track | null;
        assert.ok(mapped);
        assert.equal(
            mapped.id,
            provider === "vk" ? "vk:-01_0002" : "yandex:0007",
        );
        assert.equal(mapped.streamSource, provider);
        assert.equal(mapped.mediaSource, provider);
        assert.equal(mapped.provider?.source, provider);
        assert.equal(
            mapped.provider?.providerTrackId,
            provider === "vk" ? "-01_0002" : "0007",
        );
        assert.deepEqual(mapped.musicSourceRecording?.artists, [
            "Second",
            "First",
        ]);
        assert.equal("streamUrl" in mapped.musicSourceRecording!, false);
        assert.equal(mapped.recommendationGenerationId, "weekly-generation");
        assert.equal(mapped.recommendationQueueMode, "finite");
        assert.equal(mapped.youtubeVideoId, undefined);
    });

    test(`${provider} known playback never becomes a local or YouTube gap-fill row`, () => {
        const input = native(provider);
        for (const gaps of [[], [0]]) {
            const result = applyDiscoverProviderGapFill([input], gaps, [
                { videoId: "abcdefghijk" },
            ]);
            assert.equal(result.length, 1);
            assert.equal(result[0].sourceType, provider);
            assert.equal(result[0].streamSource, provider);
            assert.equal(result[0].id, input.id);
            assert.equal(result[0].youtubeVideoId, undefined);
        }
    });
}

test("contradictory or malformed reserved native cannot be reclassified as YT/local", () => {
    const base = native("vk");
    const variants: unknown[] = [
        {
            ...base,
            sourceType: "youtube",
            streamSource: "youtube",
            youtubeVideoId: "abcdefghijk",
        },
        { ...base, source: "local" },
        { ...base, mediaSource: "youtube" },
        { ...base, provider: { source: "yandex", providerTrackId: "0007" } },
        { ...base, id: "vk:-1_2" },
        { ...base, musicSourceRecording: null },
        {
            ...base,
            musicSourceRecording: {
                ...(base as unknown as Track).musicSourceRecording,
                preview: true,
            },
        },
        { ...base, artist: "First, Second" },
        { ...base, duration: Infinity },
        { ...base, tidalTrackId: 7 },
    ];
    for (const value of variants) {
        const row = value as DiscoverTrack;
        assert.equal(mapDiscoverTrackToPlaybackTrack(row), null);
        assert.deepEqual(
            applyDiscoverProviderGapFill(
                [row],
                [0],
                [{ videoId: "abcdefghijk" }],
            ),
            [],
        );
    }
});

test("discarding an invalid native gap consumes its original match position", () => {
    const broken = {
        ...native("vk"),
        musicSourceRecording: null,
    } as unknown as DiscoverTrack;
    const local = {
        ...native("yandex"),
        id: "local",
        sourceType: "local",
        streamSource: undefined,
        provider: undefined,
        musicSourceRecording: undefined,
    } as unknown as DiscoverTrack;
    const result = applyDiscoverProviderGapFill(
        [broken, local],
        [0, 1],
        [{ videoId: "wrongvideo00" }, { videoId: "rightvideo0a" }],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "local");
    assert.equal(result[0].youtubeVideoId, "rightvideo0a");
});

test("an explicitly null native source is rejected instead of filled from sourceType", () => {
    const row = {
        ...native("yandex"),
        source: null,
    } as unknown as DiscoverTrack;
    assert.equal(mapDiscoverTrackToPlaybackTrack(row), null);
});
