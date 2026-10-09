import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import type { OriginalRadioContinuationRequest } from "../../lib/radio/originalRadioContinuation";

const calls: OriginalRadioContinuationRequest[] = [];
let response: unknown;
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getRadioContinuation: async (
                input: OriginalRadioContinuationRequest,
            ) => {
                calls.push(input);
                return response;
            },
            getRadioTracks: async () => {
                throw new Error(
                    "Native radio cannot query local or YouTube similarity",
                );
            },
        },
    },
});
mock.module("@/lib/recommendationSession", {
    namedExports: {
        getRecommendationSessionId: () => "owned-tab",
        appendRecommendationClientContext: () => undefined,
        getRecommendationClientContext: () => null,
    },
});
const track = (provider: "vk" | "yandex", id: string) =>
    toMusicSourcePlaybackTrack({
        provider,
        id,
        title: `Song ${id}`,
        artists: ["First", "Guest"],
        duration: 180,
        contentVersion: "clean",
        preview: false,
    });

for (const provider of ["vk", "yandex"] as const) {
    test(`${provider} first radio request uses exact selected recording and an owned recommendation session`, async () => {
        const { loadTrackRadio, canLoadTrackRadio } =
            await import("../../lib/radio/loadTrackRadio");
        const id = provider === "vk" ? "-001_002" : "0007",
            seed = track(provider, id),
            next = track(provider, provider === "vk" ? "-001_003" : "0008");
        const origin = { kind: "track", source: provider, id } as const;
        response = {
            tracks: [seed, next, next],
            radioOrigin: origin,
            generationId: "generation",
            nextCursor: 1,
            degraded: false,
            degradedSources: [],
        };
        assert.equal(canLoadTrackRadio(seed), true);
        const selected = await loadTrackRadio(seed);
        assert.deepEqual(calls.at(-1), {
            origin,
            queue: [seed],
            cursor: 0,
            limit: 25,
            sessionId: "owned-tab",
        });
        assert.deepEqual(
            selected.map((t) => t.id),
            [next.id],
        );
        assert.deepEqual(selected[0].radioOrigin, origin);
        assert.equal(selected[0].recommendationSessionId, "owned-tab");
        assert.equal(selected[0].recommendationGenerationId, "generation");
        response = {
            ...(response as object),
            radioOrigin: { ...origin, id: provider === "vk" ? "-1_2" : "7" },
        };
        assert.deepEqual(await loadTrackRadio(seed), []);
        const before = calls.length;
        const invalid = { ...seed, musicSourceRecording: undefined };
        assert.equal(canLoadTrackRadio(invalid), false);
        assert.deepEqual(await loadTrackRadio(invalid), []);
        assert.equal(calls.length, before);
    });
}
