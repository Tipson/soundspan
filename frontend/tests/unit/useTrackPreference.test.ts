import assert from "node:assert/strict";
import test from "node:test";
import {
    applyOrderedOptimisticTrackPreferenceMutation,
    applyOptimisticTrackPreferenceMutation,
    buildOptimisticTrackPreferenceResponse,
    completeOrderedTrackPreferenceMutation,
    resetOrderedTrackPreferenceMutations,
} from "../../hooks/trackPreferenceOptimistic";
import { buildPreferenceMetadata } from "../../hooks/useTrackPreference";
import type { TrackPreferenceResponse } from "../../lib/api";

test("buildOptimisticTrackPreferenceResponse maps signal to expected score", () => {
    const thumbsUp = buildOptimisticTrackPreferenceResponse(
        "track-1",
        "thumbs_up",
    );
    assert.equal(thumbsUp.trackId, "track-1");
    assert.equal(thumbsUp.signal, "thumbs_up");
    assert.equal(thumbsUp.state, "liked");
    assert.equal(thumbsUp.score, 1);
    assert.ok(thumbsUp.likedAt);
    assert.equal(thumbsUp.dislikedAt, null);
    assert.ok(thumbsUp.updatedAt);

    const thumbsDown = buildOptimisticTrackPreferenceResponse(
        "track-1",
        "thumbs_down",
    );
    assert.equal(thumbsDown.trackId, "track-1");
    assert.equal(thumbsDown.signal, "thumbs_down");
    assert.equal(thumbsDown.state, "disliked");
    assert.equal(thumbsDown.score, -1);
    assert.equal(thumbsDown.likedAt, null);
    assert.ok(thumbsDown.dislikedAt);
    assert.ok(thumbsDown.updatedAt);

    const clear = buildOptimisticTrackPreferenceResponse("track-1", "clear");
    assert.equal(clear.trackId, "track-1");
    assert.equal(clear.signal, "clear");
    assert.equal(clear.state, "neutral");
    assert.equal(clear.score, 0);
    assert.equal(clear.likedAt, null);
    assert.equal(clear.dislikedAt, null);
    assert.ok(clear.updatedAt);
});

test("applyOptimisticTrackPreferenceMutation updates cache without waiting for cancellation", () => {
    const neverResolves = new Promise<void>(() => undefined);
    let setPayload: unknown = null;

    const queryClient = {
        cancelQueries: () => neverResolves,
        getQueryData: () => ({
            trackId: "track-1",
            signal: "clear" as const,
            state: "neutral" as const,
            score: 0,
            likedAt: null,
            dislikedAt: null,
            updatedAt: null,
        }),
        setQueryData: (_queryKey: unknown, nextData: unknown) => {
            setPayload = nextData;
        },
    };

    const context = applyOptimisticTrackPreferenceMutation(
        queryClient as Parameters<
            typeof applyOptimisticTrackPreferenceMutation
        >[0],
        "track-1",
        "thumbs_down",
    );

    assert.deepEqual(context.canonicalQueryKey, [
        "track-preference",
        "track-1",
    ]);
    assert.deepEqual(context.previousPreference, {
        trackId: "track-1",
        signal: "clear",
        state: "neutral",
        score: 0,
        likedAt: null,
        dislikedAt: null,
        updatedAt: null,
    });
    const optimisticPayload = setPayload as ReturnType<
        typeof buildOptimisticTrackPreferenceResponse
    >;
    assert.equal(optimisticPayload.trackId, "track-1");
    assert.equal(optimisticPayload.signal, "thumbs_down");
    assert.equal(optimisticPayload.state, "disliked");
    assert.equal(optimisticPayload.score, -1);
    assert.equal(optimisticPayload.likedAt, null);
    assert.ok(optimisticPayload.dislikedAt);
    assert.ok(optimisticPayload.updatedAt);
});

test("ordered preference mutations ignore an older failure after a newer success", () => {
    const cache = new Map<string, unknown>();
    const key = (queryKey: readonly [string, string]) =>
        JSON.stringify(queryKey);
    const queryClient = {
        cancelQueries: async () => undefined,
        getQueryData: <T>(queryKey: readonly [string, string]) =>
            cache.get(key(queryKey)) as T | undefined,
        setQueryData: (queryKey: readonly [string, string], data: unknown) =>
            cache.set(key(queryKey), data),
    };
    const canonicalQueryKey = ["track-preference", "yt:track-1"] as const;
    const neutral = buildOptimisticTrackPreferenceResponse(
        "yt:track-1",
        "clear",
    );
    queryClient.setQueryData(canonicalQueryKey, neutral);

    // These two starts model separate mounted hook instances sharing one
    // QueryClient and canonical track key.
    const older = applyOrderedOptimisticTrackPreferenceMutation(
        queryClient,
        "yt:track-1",
        "thumbs_up",
    );
    const newer = applyOrderedOptimisticTrackPreferenceMutation(
        queryClient,
        "yt:track-1",
        "thumbs_down",
    );
    const disliked = buildOptimisticTrackPreferenceResponse(
        "yt:track-1",
        "thumbs_down",
    );

    const newerCompletion = completeOrderedTrackPreferenceMutation(
        queryClient,
        newer,
        { status: "success", preference: disliked },
    );
    assert.equal(newerCompletion.isLatest, true);
    if (newerCompletion.isLatest) {
        queryClient.setQueryData(canonicalQueryKey, disliked);
    }

    const olderCompletion = completeOrderedTrackPreferenceMutation(
        queryClient,
        older,
        { status: "error" },
    );
    assert.equal(olderCompletion.isLatest, false);
    if (olderCompletion.isLatest) {
        queryClient.setQueryData(
            canonicalQueryKey,
            olderCompletion.rollbackPreference,
        );
    }

    assert.equal(
        queryClient.getQueryData<TrackPreferenceResponse>(canonicalQueryKey)
            ?.signal,
        "thumbs_down",
    );
});

test("failed newest overlapping preference rolls back to the last stable value", () => {
    const cache = new Map<string, unknown>();
    const key = (queryKey: readonly [string, string]) =>
        JSON.stringify(queryKey);
    const queryClient = {
        cancelQueries: async () => undefined,
        getQueryData: <T>(queryKey: readonly [string, string]) =>
            cache.get(key(queryKey)) as T | undefined,
        setQueryData: (queryKey: readonly [string, string], data: unknown) =>
            cache.set(key(queryKey), data),
    };
    const canonicalQueryKey = ["track-preference", "yt:track-2"] as const;
    const neutral = buildOptimisticTrackPreferenceResponse(
        "yt:track-2",
        "clear",
    );
    queryClient.setQueryData(canonicalQueryKey, neutral);

    const older = applyOrderedOptimisticTrackPreferenceMutation(
        queryClient,
        "yt:track-2",
        "thumbs_up",
    );
    const newer = applyOrderedOptimisticTrackPreferenceMutation(
        queryClient,
        "yt:track-2",
        "thumbs_down",
    );
    const newerCompletion = completeOrderedTrackPreferenceMutation(
        queryClient,
        newer,
        { status: "error" },
    );

    assert.equal(newerCompletion.isLatest, true);
    assert.equal(newerCompletion.rollbackPreference?.signal, "clear");
    const olderCompletion = completeOrderedTrackPreferenceMutation(
        queryClient,
        older,
        {
            status: "success",
            preference: buildOptimisticTrackPreferenceResponse(
                "yt:track-2",
                "thumbs_up",
            ),
        },
    );
    assert.equal(olderCompletion.isLatest, false);
});

test("reset retires an old auth-session lane without an ABA generation collision", () => {
    const cache = new Map<string, unknown>();
    const key = (queryKey: readonly [string, string]) =>
        JSON.stringify(queryKey);
    const queryClient = {
        cancelQueries: async () => undefined,
        getQueryData: <T>(queryKey: readonly [string, string]) =>
            cache.get(key(queryKey)) as T | undefined,
        setQueryData: (
            queryKey: readonly [string, string],
            data: unknown,
        ) => cache.set(key(queryKey), data),
    };
    const canonicalQueryKey = ["track-preference", "yt:shared-track"] as const;
    queryClient.setQueryData(
        canonicalQueryKey,
        buildOptimisticTrackPreferenceResponse("yt:shared-track", "clear"),
    );
    const oldSession = applyOrderedOptimisticTrackPreferenceMutation(
        queryClient,
        "yt:shared-track",
        "thumbs_up",
    );

    resetOrderedTrackPreferenceMutations(queryClient);
    queryClient.setQueryData(
        canonicalQueryKey,
        buildOptimisticTrackPreferenceResponse("yt:shared-track", "clear"),
    );
    const newSession = applyOrderedOptimisticTrackPreferenceMutation(
        queryClient,
        "yt:shared-track",
        "thumbs_down",
    );

    assert.equal(oldSession.generation, newSession.generation);
    assert.equal(
        completeOrderedTrackPreferenceMutation(queryClient, oldSession, {
            status: "success",
            preference: buildOptimisticTrackPreferenceResponse(
                "yt:shared-track",
                "thumbs_up",
            ),
        }).isLatest,
        false,
    );
    const newCompletion = completeOrderedTrackPreferenceMutation(
        queryClient,
        newSession,
        { status: "error" },
    );
    assert.equal(newCompletion.isLatest, true);
    assert.equal(newCompletion.rollbackPreference?.signal, "clear");
});

test("buildPreferenceMetadata returns metadata for remote yt: track", () => {
    const result = buildPreferenceMetadata({
        id: "yt:dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
        artist: { name: "Rick Astley" },
        album: { title: "Whenever You Need Somebody" },
        duration: 213,
        thumbnailUrl: "https://example.com/thumb.jpg",
    });
    assert.deepEqual(result, {
        title: "Never Gonna Give You Up",
        artist: "Rick Astley",
        album: "Whenever You Need Somebody",
        duration: 213,
        thumbnailUrl: "https://example.com/thumb.jpg",
    });
});

test("buildPreferenceMetadata returns metadata for remote tidal: track", () => {
    const result = buildPreferenceMetadata({
        id: "tidal:12345",
        title: "Some Song",
        artist: "Some Artist",
        album: "Some Album",
        duration: 300,
    });
    assert.deepEqual(result, {
        title: "Some Song",
        artist: "Some Artist",
        album: "Some Album",
        duration: 300,
        thumbnailUrl: undefined,
    });
});

test("buildPreferenceMetadata returns undefined for local track", () => {
    const result = buildPreferenceMetadata({
        id: "cuid-local-track-id",
        title: "Local Song",
        artist: { name: "Local Artist" },
        album: { title: "Local Album" },
        duration: 200,
    });
    assert.equal(result, undefined);
});

test("buildPreferenceMetadata returns undefined for null/undefined input", () => {
    assert.equal(buildPreferenceMetadata(null), undefined);
    assert.equal(buildPreferenceMetadata(undefined), undefined);
});

test("buildPreferenceMetadata handles missing artist/album gracefully", () => {
    const result = buildPreferenceMetadata({
        id: "yt:abc123",
        title: "Partial Track",
        duration: 180,
    });
    assert.deepEqual(result, {
        title: "Partial Track",
        artist: undefined,
        album: undefined,
        duration: 180,
        thumbnailUrl: undefined,
    });
});
