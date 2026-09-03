import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createPlayEngagementTracker,
    resolvePlaybackRecommendationContext,
    resolvePlaybackRecommendationSessionId,
} from "../../components/player/hooks/playEngagementSession";
import type {
    PlayEngagementInput,
    PlayLogInput,
    PlayLogResponse,
} from "../../lib/api/plays";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

test("recommendation context maps playback routes and preserves the Wave mode", () => {
    assert.deepEqual(
        resolvePlaybackRecommendationContext("/vibe", true, "new"),
        { playContext: "wave", waveMode: "new" },
    );
    assert.deepEqual(
        resolvePlaybackRecommendationContext(
            "/playlist/playlist-1",
            false,
            "familiar",
        ),
        { playContext: "playlist" },
    );
    assert.deepEqual(
        resolvePlaybackRecommendationContext("/search", false, "for-you"),
        { playContext: "search" },
    );
});

test("every online play joins the current tab session while preserving direct lineage", () => {
    assert.equal(
        resolvePlaybackRecommendationSessionId(
            "generation-session",
            "tab-session",
        ),
        "generation-session",
    );
    assert.equal(
        resolvePlaybackRecommendationSessionId(undefined, "tab-session"),
        "tab-session",
    );
});

test("completed playback is patched once even when POST resolves after the end", async () => {
    const created = deferred<PlayLogResponse>();
    const logged: PlayLogInput[] = [];
    const patched: Array<{ id: string; input: PlayEngagementInput }> = [];
    const tracker = createPlayEngagementTracker({
        logPlay: (input) => {
            logged.push(input);
            return created.promise;
        },
        updatePlayEngagement: async (id, input) => {
            patched.push({ id, input });
            return { success: true };
        },
    });

    tracker.start({
        key: "yt:video-1",
        play: {
            youtubeVideoId: "video-1",
            title: "Numb",
            artist: "Linkin Park",
            album: "Meteora",
            duration: 100,
            playContext: "wave",
            waveMode: "familiar",
        },
        durationSeconds: 100,
    });
    tracker.noteProgress(0);
    tracker.noteProgress(5);
    tracker.noteProgress(10);
    tracker.finish("completed");
    tracker.finish("completed");

    assert.equal(logged.length, 1);
    assert.equal(patched.length, 0);

    created.resolve({ id: "play-late" });
    await flushAsync();

    assert.deepEqual(patched, [
        {
            id: "play-late",
            input: {
                listenedSeconds: 10,
                completionRatio: 1,
                outcome: "completed",
            },
        },
    ]);
});

test("track transition distinguishes early skip from meaningful listening", async () => {
    let playNumber = 0;
    const patched: Array<{ id: string; input: PlayEngagementInput }> = [];
    const tracker = createPlayEngagementTracker({
        logPlay: async () => ({ id: `play-${++playNumber}` }),
        updatePlayEngagement: async (id, input) => {
            patched.push({ id, input });
            return { success: true };
        },
    });

    const play = {
        youtubeVideoId: "video-1",
        title: "Track",
        artist: "Artist",
        album: "Album",
        duration: 200,
    } as const;
    tracker.start({ key: "first", play, durationSeconds: 200 });
    tracker.noteProgress(0);
    tracker.noteProgress(8);
    tracker.transitionTo("second");
    await flushAsync();

    tracker.start({
        key: "second",
        play: { ...play, youtubeVideoId: "video-2" },
        durationSeconds: 200,
    });
    tracker.noteProgress(0);
    for (let position = 5; position <= 45; position += 5) {
        tracker.noteProgress(position);
    }
    tracker.transitionTo("third");
    await flushAsync();

    assert.deepEqual(
        patched.map(({ input }) => input.outcome),
        ["skipped", "meaningful"],
    );
    assert.deepEqual(
        patched.map(({ input }) => input.listenedSeconds),
        [8, 45],
    );
});

test("fatal playback error wins once and bounded values are sent", async () => {
    const patched: PlayEngagementInput[] = [];
    const tracker = createPlayEngagementTracker({
        logPlay: async () => ({ id: "play-failed" }),
        updatePlayEngagement: async (_id, input) => {
            patched.push(input);
            return { success: true };
        },
    });

    tracker.start({
        key: "failed",
        play: {
            tidalTrackId: 42,
            title: "Track",
            artist: "Artist",
            album: "Album",
            duration: 10,
        },
        durationSeconds: 10,
    });
    tracker.noteProgress(Number.POSITIVE_INFINITY);
    tracker.noteProgress(0);
    tracker.noteProgress(20);
    tracker.finish("failed");
    tracker.transitionTo(null);
    await flushAsync();

    assert.deepEqual(patched, [
        {
            listenedSeconds: 0,
            completionRatio: 1,
            outcome: "failed",
        },
    ]);
});
