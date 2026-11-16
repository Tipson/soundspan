import assert from "node:assert/strict";
import test from "node:test";
import type { Track } from "../../lib/audio-state-context";
import {
    RecommendationQueueFeedback,
    recommendationScopeForTrack,
    resolveRecommendationFeedbackAck,
} from "../../lib/audio/recommendationQueueFeedback";

function track(id: string, session: string | null = "session-a"): Track {
    return {
        id,
        title: id,
        artist: { name: "Один и тот же артист" },
        album: { title: "Album" },
        duration: 180,
        ...(session ? { recommendationSessionId: session } : {}),
    };
}
const scope = recommendationScopeForTrack(track("song"))!;

test("ACK admission accepts exact applied policy and legacy signal without guessing broader scope", () => {
    for (const signal of ["clear", "thumbs_up", "thumbs_down"] as const) {
        const response = { trackId: "song", signal };
        const queuePolicy = {
            version: 1,
            scope: "exact_recording",
            appliesTo: "recommended_future",
            trackId: "song",
            effect: signal === "thumbs_down" ? "exclude" : "allow",
        };
        assert.equal(
            resolveRecommendationFeedbackAck("song", response),
            signal,
        );
        assert.equal(
            resolveRecommendationFeedbackAck("song", {
                ...response,
                queuePolicy,
            }),
            signal,
        );
        for (const override of [
            { version: 2 },
            { scope: "artist" },
            { scope: "verified_alias" },
            { appliesTo: "manual_playlist" },
            { trackId: "foreign" },
            { effect: signal === "thumbs_down" ? "allow" : "exclude" },
        ])
            assert.equal(
                resolveRecommendationFeedbackAck("song", {
                    ...response,
                    queuePolicy: { ...queuePolicy, ...override },
                }),
                null,
            );
    }
    for (const invalid of [
        null,
        [],
        {},
        { trackId: "foreign", signal: "clear" },
        { trackId: "song", signal: "ban" },
        { trackId: "song", signal: "clear", queuePolicy: null },
    ])
        assert.equal(resolveRecommendationFeedbackAck("song", invalid), null);
});

test("exact feedback prunes only future recommended occurrences, keeping current, history and manual rows", () => {
    const guard = new RecommendationQueueFeedback();
    const before = {
        queue: [
            track("a"),
            track("b"),
            track("a"),
            track("c"),
            track("a", null),
        ],
        currentIndex: 1,
        isShuffle: false,
        shuffleIndices: [],
    };
    guard.begin({ trackId: "a", scope, signal: "thumbs_down" });
    const after = guard.pruneFuture(before);
    assert.deepEqual(
        after.queue.map((row) => row.id),
        ["a", "b", "c", "a"],
    );
    assert.equal(after.queue[after.currentIndex], before.queue[1]);
    assert.equal(before.queue.length, 5);
    assert.equal(guard.allows(track("b")), true);
    assert.equal(guard.allows(track("a")), false);
    assert.equal(guard.allows(track("a", null)), true);
});

test("shuffle pruning follows its upcoming positions rather than physical indices", () => {
    const guard = new RecommendationQueueFeedback();
    const rows = [track("a"), track("b"), track("c"), track("a")];
    guard.begin({ trackId: "a", scope, signal: "thumbs_down" });
    const after = guard.pruneFuture({
        queue: rows,
        currentIndex: 2,
        isShuffle: true,
        shuffleIndices: [3, 2, 0, 1],
    });
    assert.deepEqual(after.queue, [rows[1], rows[2], rows[3]]);
    assert.equal(after.currentIndex, 1);
    assert.deepEqual(after.shuffleIndices, [2, 1, 0]);
});

test("late refill is filtered and Undo permits fresh admission without restoring removed occurrences", () => {
    const guard = new RecommendationQueueFeedback();
    guard.begin({ trackId: "a", scope, signal: "thumbs_down" });
    const retained = guard.pruneFuture({
        queue: [track("b"), track("a")],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
    });
    assert.equal(guard.allows(track("a")), false);
    guard.begin({ trackId: "a", scope, signal: "clear" });
    assert.equal(guard.allows(track("a")), true);
    assert.deepEqual(
        retained.queue.map((row) => row.id),
        ["b"],
    );
});

test("a missing shuffle position never guesses played history from physical indices", () => {
    const guard = new RecommendationQueueFeedback();
    guard.begin({ trackId: "a", scope, signal: "thumbs_down" });
    const input = {
        queue: [track("b"), track("a")],
        currentIndex: 0,
        isShuffle: true,
        shuffleIndices: [],
    };
    assert.equal(guard.pruneFuture(input), input);
    assert.equal(
        guard.allows(input.queue[1]),
        false,
        "automatic admission still excludes it while order is rebuilt",
    );
});

test("a delayed negative cannot overwrite a newer clear or borrow a new owner's guard", () => {
    const guard = new RecommendationQueueFeedback();
    const first = guard.begin({ trackId: "a", scope, signal: "thumbs_down" })!;
    const second = guard.begin({ trackId: "a", scope, signal: "clear" })!;
    assert.equal(guard.reconcile(second, "clear"), true);
    assert.equal(guard.reconcile(first, "thumbs_down"), false);
    assert.equal(guard.allows(track("a")), true);
    const old = guard.begin({ trackId: "a", scope, signal: "thumbs_down" })!;
    guard.reset();
    assert.equal(guard.reconcile(old, "thumbs_down"), false);
    assert.equal(guard.allows(track("a")), true);
    const other = new RecommendationQueueFeedback();
    assert.equal(other.reconcile(old, "thumbs_down"), false);
    assert.equal(other.allows(track("a")), true);
});

test("session scope spans continuation generations but does not affect another session", () => {
    const guard = new RecommendationQueueFeedback();
    guard.begin({ trackId: "a", scope, signal: "thumbs_down" });
    assert.equal(
        guard.allows({
            ...track("a"),
            recommendationGenerationId: "generation-new",
        }),
        false,
    );
    assert.equal(guard.allows(track("a", "session-b")), true);
    assert.equal(
        recommendationScopeForTrack({
            ...track("a", null),
            recommendationGenerationId: "legacy-generation",
        }),
        "generation:legacy-generation",
    );
});

test("feedback overflow is bounded and closes only its recommendation scope", () => {
    const guard = new RecommendationQueueFeedback();
    for (let i = 0; i <= 2000; i++) {
        const intent = guard.begin({
            trackId: `song-${i}`,
            scope,
            signal: "thumbs_down",
        });
        if (intent) guard.reconcile(intent, "thumbs_down");
    }
    assert.equal(guard.allows(track("unseen")), false);
    assert.equal(guard.allows(track("unseen", "fresh-session")), true);
    assert.equal(guard.allows(track("unseen", null)), true);
    guard.reset();
    assert.equal(guard.allows(track("unseen")), true);
});

test("exact local backing is not collapsed into its fallback provider recording", () => {
    const guard = new RecommendationQueueFeedback();
    const local = {
        ...track("db-row"),
        filePath: "/music/one.flac",
        youtubeVideoId: "video",
        streamSource: "youtube" as const,
    };
    guard.begin({ trackId: "db-row", scope, signal: "thumbs_down" });
    assert.equal(guard.allows(local), false);
    assert.equal(
        guard.allows({
            ...track("yt:video"),
            youtubeVideoId: "video",
            streamSource: "youtube",
        }),
        true,
    );
});

test("invalid or absent recommendation scope does not become a manual queue ban", () => {
    const guard = new RecommendationQueueFeedback();
    assert.equal(
        guard.begin({ trackId: "a", scope: null, signal: "thumbs_down" }),
        null,
    );
    assert.equal(
        recommendationScopeForTrack({
            ...track("a", null),
            recommendationSessionId: "\u0000",
        }),
        null,
    );
    assert.equal(guard.allows(track("a", null)), true);
});

test("a nullable legacy session falls back to a valid generation", () => {
    const legacy = {
        ...track("a", null),
        recommendationSessionId: null,
        recommendationGenerationId: "old-generation",
    } as unknown as Track;
    assert.equal(
        recommendationScopeForTrack(legacy),
        "generation:old-generation",
    );
});

test("a portable checkpoint retains masks but never lends authority to an old receipt", () => {
    const guard = new RecommendationQueueFeedback();
    const oldIntent = guard.begin({
        trackId: "a",
        scope,
        signal: "thumbs_down",
    })!;
    const row = guard.toCheckpoint();
    const restored = RecommendationQueueFeedback.fromCheckpoint(
        JSON.parse(JSON.stringify(row)),
    );
    assert.equal(restored.allows(track("a")), false);
    assert.equal(restored.reconcile(oldIntent, "clear"), false);
    const fresh = restored.begin({ trackId: "a", scope, signal: "clear" })!;
    restored.reconcile(fresh, "clear");
    assert.equal(restored.allows(track("a")), true);
    assert.equal(guard.allows(track("a")), false);
    assert.equal(JSON.stringify(row).includes("pending"), false);
});

test("absent policy is compatible; unknown or corrupt policy closes automatic admission only", () => {
    assert.equal(
        RecommendationQueueFeedback.fromCheckpoint(null).allows(track("a")),
        true,
    );
    const good = new RecommendationQueueFeedback();
    good.begin({ trackId: "a", scope, signal: "thumbs_down" });
    const row = good.toCheckpoint();
    for (const corrupt of [
        { version: 999 },
        { ...row, exclusions: [{ scope, trackIds: ["x".repeat(513)] }] },
        { ...row, exclusions: [row.exclusions[0], row.exclusions[0]] },
        { ...row, closedScopes: Array(2001).fill(scope) },
        { ...row, credential: "must not be stored" },
    ]) {
        const restored = RecommendationQueueFeedback.fromCheckpoint(corrupt);
        assert.equal(restored.allows(track("a")), false);
        assert.equal(restored.allows(track("other")), false);
        assert.equal(restored.allows(track("a", null)), true);
        restored.reset();
        assert.equal(restored.allows(track("a")), true);
    }
});
