import assert from "node:assert/strict";
import { test } from "node:test";
import {
    resolveVibeMotionProfile,
    shouldAnimateVibeAmbient,
} from "../../components/vibe/vibeMotionProfile";

test("Vibe ambient motion follows analyzed tempo and energy when present", () => {
    const profile = resolveVibeMotionProfile({
        trackId: "track:analyzed",
        bpm: 144,
        energy: 0.82,
        mode: "for-you",
        mood: null,
    });

    assert.equal(profile.bpm, 144);
    assert.equal(profile.energy, 0.82);
    assert.equal(profile.tempoSource, "analyzed");
    assert.equal(profile.energySource, "analyzed");
    assert.equal(profile.beatIntervalMs, 60_000 / 144);
});

test("Vibe ambient fallback is deterministic and mood-aware", () => {
    const calm = resolveVibeMotionProfile({
        trackId: "yt:provider-track",
        bpm: null,
        energy: null,
        mode: "for-you",
        mood: "calm",
    });
    const repeatedCalm = resolveVibeMotionProfile({
        trackId: "yt:provider-track",
        bpm: undefined,
        energy: undefined,
        mode: "for-you",
        mood: "calm",
    });
    const workout = resolveVibeMotionProfile({
        trackId: "yt:provider-track",
        bpm: null,
        energy: null,
        mode: "for-you",
        mood: "workout",
    });

    assert.deepEqual(calm, repeatedCalm);
    assert.equal(calm.tempoSource, "deterministic-fallback");
    assert.equal(calm.energySource, "deterministic-fallback");
    assert.ok(workout.bpm > calm.bpm);
    assert.ok(workout.energy > calm.energy);
});

test("Vibe ambient motion only runs while audible, visible and motion-safe", () => {
    assert.equal(
        shouldAnimateVibeAmbient({
            isDesktop: true,
            isPlaying: true,
            isVisible: true,
            prefersReducedMotion: false,
            lowPower: false,
        }),
        true,
    );
    for (const inhibited of [
        { prefersReducedMotion: true },
        { isPlaying: false },
        { isVisible: false },
        { lowPower: true },
        { isDesktop: false },
    ]) {
        assert.equal(
            shouldAnimateVibeAmbient({
                isDesktop: true,
                isPlaying: true,
                isVisible: true,
                prefersReducedMotion: false,
                lowPower: false,
                ...inhibited,
            }),
            false,
        );
    }
});
