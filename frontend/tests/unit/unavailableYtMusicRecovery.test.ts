import assert from "node:assert/strict";
import test from "node:test";
import type { Track } from "../../lib/audio-state-context";
import {
    createUnavailableYtMusicRecoveryCoordinator,
    type UnavailableYtMusicRecoveryRequest,
    type UnavailableYtMusicRecoveryResponse,
} from "../../lib/audio/unavailableYtMusicRecovery";

const makeTrack = (id = "yt:z0NfI2NeDHI", videoId = "z0NfI2NeDHI"): Track => ({
    id,
    title: "Radio (Official Video)",
    artist: { name: "Rammstein" },
    album: { title: "Rammstein" },
    duration: 275,
    streamSource: "youtube",
    youtubeVideoId: videoId,
    playlistItemId: "playlist-item-1",
    trackYtMusicId: "yt-row-original",
});

const replacementResponse: UnavailableYtMusicRecoveryResponse = {
    status: "replaced",
    originalVideoId: "z0NfI2NeDHI",
    replacement: {
        videoId: "alternate02",
        title: "Radio",
        duration: 274,
        trackYtMusicId: "yt-row-alternate",
    },
    persisted: true,
};

test("correlated recovery excludes the original and applies a validated replacement once", async () => {
    const track = makeTrack();
    let currentTrack: Track | null = track;
    const requests: UnavailableYtMusicRecoveryRequest[] = [];
    const applied: string[] = [];
    const coordinator = createUnavailableYtMusicRecoveryCoordinator({
        request: async (input) => {
            requests.push(input);
            return replacementResponse;
        },
        getCurrentTrack: () => currentTrack,
        applyReplacement: (_expected, replacement) => {
            applied.push(replacement.videoId);
            currentTrack = {
                ...track,
                youtubeVideoId: replacement.videoId,
            };
        },
    });

    await assert.doesNotReject(async () => {
        assert.equal(await coordinator.recover(track), "replaced");
    });
    assert.deepEqual(requests, [
        {
            originalVideoId: "z0NfI2NeDHI",
            artist: "Rammstein",
            title: "Radio (Official Video)",
            albumTitle: "Rammstein",
            duration: 275,
            excludedVideoIds: ["z0NfI2NeDHI"],
            playlistItemId: "playlist-item-1",
            expectedTrackYtMusicId: "yt-row-original",
        },
    ]);
    assert.deepEqual(applied, ["alternate02"]);
});

test("late recovery response cannot replace a newly selected track", async () => {
    const failedTrack = makeTrack();
    const nextTrack = makeTrack("yt:nextvideo01", "nextvideo01");
    let currentTrack: Track | null = failedTrack;
    let resolveRequest!: (value: UnavailableYtMusicRecoveryResponse) => void;
    let applyCount = 0;
    const coordinator = createUnavailableYtMusicRecoveryCoordinator({
        request: () =>
            new Promise((resolve) => {
                resolveRequest = resolve;
            }),
        getCurrentTrack: () => currentTrack,
        applyReplacement: () => {
            applyCount += 1;
        },
    });

    const recovery = coordinator.recover(failedTrack);
    await Promise.resolve();
    currentTrack = nextTrack;
    resolveRequest(replacementResponse);

    assert.equal(await recovery, "stale");
    assert.equal(applyCount, 0);
});

test("late recovery response cannot replace another occurrence of the same provider track", async () => {
    const failedTrack = makeTrack();
    const duplicateOccurrence = {
        ...failedTrack,
        playlistItemId: "playlist-item-2",
    };
    let currentTrack: Track | null = failedTrack;
    let resolveRequest!: (value: UnavailableYtMusicRecoveryResponse) => void;
    let applyCount = 0;
    const coordinator = createUnavailableYtMusicRecoveryCoordinator({
        request: () =>
            new Promise((resolve) => {
                resolveRequest = resolve;
            }),
        getCurrentTrack: () => currentTrack,
        applyReplacement: () => {
            applyCount += 1;
        },
    });

    const recovery = coordinator.recover(failedTrack);
    await Promise.resolve();
    currentTrack = duplicateOccurrence;
    resolveRequest(replacementResponse);

    assert.equal(await recovery, "stale");
    assert.equal(applyCount, 0);
});

test("concurrent identical failures share one request and one replacement commit", async () => {
    const track = makeTrack();
    let requestCount = 0;
    let applyCount = 0;
    const coordinator = createUnavailableYtMusicRecoveryCoordinator({
        request: async () => {
            requestCount += 1;
            await Promise.resolve();
            return replacementResponse;
        },
        getCurrentTrack: () => track,
        applyReplacement: () => {
            applyCount += 1;
        },
    });

    const [first, second] = await Promise.all([
        coordinator.recover(track),
        coordinator.recover(track),
    ]);

    assert.deepEqual([first, second], ["replaced", "replaced"]);
    assert.equal(requestCount, 1);
    assert.equal(applyCount, 1);
});

test("no candidate is reported without mutating the current track", async () => {
    const track = makeTrack();
    let applyCount = 0;
    const coordinator = createUnavailableYtMusicRecoveryCoordinator({
        request: async () => ({
            status: "no_candidate",
            originalVideoId: track.youtubeVideoId!,
            replacement: null,
            persisted: false,
        }),
        getCurrentTrack: () => track,
        applyReplacement: () => {
            applyCount += 1;
        },
    });

    assert.equal(await coordinator.recover(track), "no_candidate");
    assert.equal(applyCount, 0);
});

test("mismatched server correlation is rejected without applying it", async () => {
    const track = makeTrack();
    let applyCount = 0;
    const coordinator = createUnavailableYtMusicRecoveryCoordinator({
        request: async () => ({
            ...replacementResponse,
            originalVideoId: "othertrack1",
        }),
        getCurrentTrack: () => track,
        applyReplacement: () => {
            applyCount += 1;
        },
    });

    assert.equal(await coordinator.recover(track), "failed");
    assert.equal(applyCount, 0);
});

test("a malformed replaced response fails closed without rejecting", async () => {
    const track = makeTrack();
    let applyCount = 0;
    const coordinator = createUnavailableYtMusicRecoveryCoordinator({
        request: async () =>
            ({
                status: "replaced",
                originalVideoId: track.youtubeVideoId,
                replacement: null,
                persisted: true,
            }) as unknown as UnavailableYtMusicRecoveryResponse,
        getCurrentTrack: () => track,
        applyReplacement: () => {
            applyCount += 1;
        },
    });

    await assert.doesNotReject(async () => {
        assert.equal(await coordinator.recover(track), "failed");
    });
    assert.equal(applyCount, 0);
});

test("a response finishing after player unmount is stale", async () => {
    const track = makeTrack();
    let active = true;
    let resolveRequest!: (value: UnavailableYtMusicRecoveryResponse) => void;
    let applyCount = 0;
    const coordinator = createUnavailableYtMusicRecoveryCoordinator({
        request: () =>
            new Promise((resolve) => {
                resolveRequest = resolve;
            }),
        getCurrentTrack: () => track,
        isActive: () => active,
        applyReplacement: () => {
            applyCount += 1;
        },
    });

    const recovery = coordinator.recover(track);
    await Promise.resolve();
    active = false;
    resolveRequest(replacementResponse);

    assert.equal(await recovery, "stale");
    assert.equal(applyCount, 0);
});

test("an unpersisted row id is not attached to the playlist item in memory", async () => {
    const track = makeTrack();
    let appliedTrackYtMusicId: string | undefined;
    const coordinator = createUnavailableYtMusicRecoveryCoordinator({
        request: async () => ({
            ...replacementResponse,
            persisted: false,
        }),
        getCurrentTrack: () => track,
        applyReplacement: (_expected, replacement) => {
            appliedTrackYtMusicId = replacement.trackYtMusicId;
        },
    });

    assert.equal(await coordinator.recover(track), "replaced");
    assert.equal(appliedTrackYtMusicId, undefined);
});
