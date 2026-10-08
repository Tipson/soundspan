import assert from "node:assert/strict";
import { test } from "node:test";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import {
    buildProviderRadioContinuationPath,
    collectProviderRadioContinuation,
    isProviderRadioTrack,
} from "../../lib/audio/providerRadioContinuation";
import type {
    PersonalizedTrack,
    PersonalizedHomeFeed,
} from "../../features/home/types";

for (const provider of ["vk", "yandex"] as const) {
    const recording = {
        provider,
        id: provider === "vk" ? "-01_0002" : "0002",
        title: "Personal music",
        artists: ["Band", "Guest"],
        duration: 180,
        preview: false as const,
        contentVersion: "unknown" as const,
    };
    const track = toMusicSourcePlaybackTrack(recording);
    const row = {
        ...track,
        trackNo: null,
        artist: { id: null, name: recording.artists.join(", ") },
        album: {
            id: null,
            title: "",
            coverArt: "",
            artist: { id: null, name: recording.artists.join(", ") },
        },
    } as PersonalizedTrack;
    test(`${provider} native current continues personal Wave without original radio origin`, () =>
        assert.equal(isProviderRadioTrack(track), true));
    test(`${provider} personal Wave collector preserves exact recording/lineage`, () => {
        const feed: PersonalizedHomeFeed = {
            shelves: { listenAgain: [], quickPicks: [], discovery: [row] },
            generationId: "native-personal-generation",
            degraded: false,
            reason: null,
            seedCount: 1,
            nextCursor: 1,
        };
        const result = collectProviderRadioContinuation(feed, [], 25);
        assert.equal(result.length, 1);
        assert.equal(result[0].id, track.id);
        assert.deepEqual(result[0].musicSourceRecording, recording);
        assert.equal(result[0].recommendationGenerationId, feed.generationId);
        assert.equal(result[0].radioOrigin, undefined);
        assert.equal(result[0].recommendationQueueMode, undefined);
        assert.deepEqual(
            collectProviderRadioContinuation(feed, [track], 25),
            [],
        );
    });
    test(`${provider} reserved native queue identity cannot borrow contradictory legacy exclusion fields`, () => {
        const params = new URLSearchParams(
            buildProviderRadioContinuationPath(
                [{ ...track, youtubeVideoId: "legacy-video" }],
                1,
                25,
                "for-you",
                null,
                null,
            ).split("?")[1],
        );
        assert.equal(params.get("exclude"), null);
        assert.equal(params.get("surface"), "wave");
    });
    test(`${provider} malformed reserved native is neither local nor YouTube continuation`, () => {
        const bad = {
            ...row,
            source: "youtube" as const,
            youtubeVideoId: "legacy-video",
        };
        const feed: PersonalizedHomeFeed = {
            shelves: { listenAgain: [], quickPicks: [], discovery: [bad, row] },
            generationId: "g",
            degraded: false,
            reason: null,
            seedCount: 1,
            nextCursor: 1,
        };
        assert.equal(isProviderRadioTrack(bad as any), false);
        const result = collectProviderRadioContinuation(feed, [], 25);
        assert.equal(result.length, 1);
        assert.equal(result[0].id, track.id);
    });
}
