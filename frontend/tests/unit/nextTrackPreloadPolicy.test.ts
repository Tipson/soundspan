import assert from "node:assert/strict";
import test from "node:test";
import {
    NETWORK_PRELOAD_STABLE_PROGRESS_SECONDS,
    resolveNetworkNextTrackPreloadDecision,
    resolveNextTrackPreloadDecision,
} from "../../lib/audio-engine/nextTrackPreloadPolicy";

test("eligible for preload in normal track playback", () => {
    const decision = resolveNextTrackPreloadDecision({
        playbackType: "track",
        repeatMode: "off",
        isListenTogether: false,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, true);
    assert.equal(decision.reason, "eligible");
});

test("eligible with repeat-all", () => {
    const decision = resolveNextTrackPreloadDecision({
        playbackType: "track",
        repeatMode: "all",
        isListenTogether: false,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, true);
});

test("not eligible for podcast playback", () => {
    const decision = resolveNextTrackPreloadDecision({
        playbackType: "podcast",
        repeatMode: "off",
        isListenTogether: false,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, false);
    assert.equal(decision.reason, "not_track_playback");
});

test("not eligible for audiobook playback", () => {
    const decision = resolveNextTrackPreloadDecision({
        playbackType: "audiobook",
        repeatMode: "off",
        isListenTogether: false,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, false);
});

test("not eligible in repeat-one mode", () => {
    const decision = resolveNextTrackPreloadDecision({
        playbackType: "track",
        repeatMode: "one",
        isListenTogether: false,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, false);
    assert.equal(decision.reason, "repeat_one_handles_itself");
});

test("not eligible in listen-together session", () => {
    const decision = resolveNextTrackPreloadDecision({
        playbackType: "track",
        repeatMode: "off",
        isListenTogether: true,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, false);
    assert.equal(decision.reason, "listen_together_controlled");
});

test("not eligible when already loading", () => {
    const decision = resolveNextTrackPreloadDecision({
        playbackType: "track",
        repeatMode: "off",
        isListenTogether: false,
        isLoading: true,
    });
    assert.equal(decision.shouldPreload, false);
    assert.equal(decision.reason, "already_loading");
});

test("not eligible when playbackType is null", () => {
    const decision = resolveNextTrackPreloadDecision({
        playbackType: null,
        repeatMode: "off",
        isListenTogether: false,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, false);
});

test("network YouTube preload starts after the current track has proven audible", () => {
    const decision = resolveNetworkNextTrackPreloadDecision({
        nextStreamSource: "youtube",
        currentTimeSec: NETWORK_PRELOAD_STABLE_PROGRESS_SECONDS,
        isPlaying: true,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, true);
    assert.equal(decision.reason, "stable_playback");
});

test("network YouTube preload stays idle until audible progress is stable", () => {
    const decision = resolveNetworkNextTrackPreloadDecision({
        nextStreamSource: "youtube",
        currentTimeSec: NETWORK_PRELOAD_STABLE_PROGRESS_SECONDS - 0.01,
        isPlaying: true,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, false);
    assert.equal(decision.reason, "playback_not_stable");
});

test("network YouTube preload does not wait for end-of-track timing", () => {
    const decision = resolveNetworkNextTrackPreloadDecision({
        nextStreamSource: "youtube",
        currentTimeSec: NETWORK_PRELOAD_STABLE_PROGRESS_SECONDS,
        isPlaying: true,
        isLoading: false,
    });
    assert.equal(decision.shouldPreload, true);
});

test("network preload does not create provider work for paused, loading, or non-YouTube media", () => {
    for (const input of [
        {
            nextStreamSource: "youtube",
            currentTimeSec: 190,
            isPlaying: false,
            isLoading: false,
        },
        {
            nextStreamSource: "youtube",
            currentTimeSec: 190,
            isPlaying: true,
            isLoading: true,
        },
        {
            nextStreamSource: "tidal",
            currentTimeSec: 190,
            isPlaying: true,
            isLoading: false,
        },
    ]) {
        assert.equal(
            resolveNetworkNextTrackPreloadDecision(input).shouldPreload,
            false,
        );
    }
});
