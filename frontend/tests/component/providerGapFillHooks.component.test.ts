import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

type DependencyList = ReadonlyArray<unknown> | undefined;

function depsChanged(prev: DependencyList, next: DependencyList): boolean {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    for (let index = 0; index < prev.length; index += 1) {
        if (!Object.is(prev[index], next[index])) {
            return true;
        }
    }
    return false;
}

function createHookRuntime() {
    const stateValues: unknown[] = [];
    const refValues: Array<{ current: unknown }> = [];
    const memoValues: unknown[] = [];
    const memoDeps: DependencyList[] = [];
    const effectDeps: DependencyList[] = [];
    const cleanupByIndex: Array<(() => void) | undefined> = [];
    const pendingEffects: Array<() => void> = [];
    let hookIndex = 0;

    return {
        beginRender() {
            hookIndex = 0;
        },
        reset() {
            stateValues.length = 0;
            refValues.length = 0;
            memoValues.length = 0;
            memoDeps.length = 0;
            effectDeps.length = 0;
            for (const cleanup of cleanupByIndex) {
                cleanup?.();
            }
            cleanupByIndex.length = 0;
            pendingEffects.length = 0;
            hookIndex = 0;
        },
        useState<T>(initial: T | (() => T)) {
            const idx = hookIndex;
            hookIndex += 1;
            if (!(idx in stateValues)) {
                stateValues[idx] =
                    typeof initial === "function"
                        ? (initial as () => T)()
                        : initial;
            }
            const setState = (value: T | ((current: T) => T)) => {
                const current = stateValues[idx] as T;
                stateValues[idx] =
                    typeof value === "function"
                        ? (value as (current: T) => T)(current)
                        : value;
            };
            return [stateValues[idx] as T, setState] as const;
        },
        useRef<T>(initial: T) {
            const idx = hookIndex;
            hookIndex += 1;
            if (!(idx in refValues)) {
                refValues[idx] = { current: initial };
            }
            return refValues[idx] as { current: T };
        },
        useMemo<T>(factory: () => T, deps: DependencyList) {
            const idx = hookIndex;
            hookIndex += 1;
            if (!(idx in memoValues) || depsChanged(memoDeps[idx], deps)) {
                memoValues[idx] = factory();
                memoDeps[idx] = deps;
            }
            return memoValues[idx] as T;
        },
        useCallback<T extends (...args: never[]) => unknown>(
            callback: T,
            deps: DependencyList,
        ) {
            return this.useMemo(() => callback, deps);
        },
        useEffect(effect: () => void | (() => void), deps: DependencyList) {
            const idx = hookIndex;
            hookIndex += 1;
            if (depsChanged(effectDeps[idx], deps)) {
                effectDeps[idx] = deps;
                pendingEffects.push(() => {
                    cleanupByIndex[idx]?.();
                    const cleanup = effect();
                    cleanupByIndex[idx] =
                        typeof cleanup === "function" ? cleanup : undefined;
                });
            }
        },
        async flushEffects() {
            const queue = pendingEffects.splice(0, pendingEffects.length);
            for (const runEffect of queue) {
                runEffect();
            }
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

const runtime = createHookRuntime();

const loggerState = {
    errors: [] as string[],
};

const apiState = {
    tidalStatus: {
        enabled: true,
        available: true,
        authenticated: true,
    },
    ytStatus: {
        enabled: true,
        available: true,
        authenticated: true,
    },
    failTidalStatus: false,
    failYtStatus: false,
    rejectTidalBatch: false,
    rejectYtBatch: false,
    throwTidalBatch: false,
    throwYtBatch: false,
    tidalMatches: [] as Array<Record<string, unknown> | null>,
    ytMatches: [] as Array<Record<string, unknown> | null>,
    tidalPayloads: [] as Array<Record<string, unknown>[]>,
    ytPayloads: [] as Array<Record<string, unknown>[]>,
};

mock.module("react", {
    namedExports: {
        useState: runtime.useState.bind(runtime),
        useRef: runtime.useRef.bind(runtime),
        useMemo: runtime.useMemo.bind(runtime),
        useCallback: runtime.useCallback.bind(runtime),
        useEffect: runtime.useEffect.bind(runtime),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: (...args: unknown[]) => {
                loggerState.errors.push(args.map(String).join(" "));
            },
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTidalStreamingStatus: async () => {
                if (apiState.failTidalStatus) {
                    throw new Error("tidal status failed");
                }
                return apiState.tidalStatus;
            },
            getYtMusicStatus: async () => {
                if (apiState.failYtStatus) {
                    throw new Error("yt status failed");
                }
                return apiState.ytStatus;
            },
            matchTidalBatch: (payload: Array<Record<string, unknown>>) => {
                apiState.tidalPayloads.push(payload);
                if (apiState.throwTidalBatch) {
                    throw new Error("tidal batch threw");
                }
                if (apiState.rejectTidalBatch) {
                    return Promise.reject(new Error("tidal batch failed"));
                }
                return Promise.resolve({
                    matches: apiState.tidalMatches,
                });
            },
            matchYtMusicBatch: (payload: Array<Record<string, unknown>>) => {
                apiState.ytPayloads.push(payload);
                if (apiState.throwYtBatch) {
                    throw new Error("yt batch threw");
                }
                if (apiState.rejectYtBatch) {
                    return Promise.reject(new Error("yt batch failed"));
                }
                return Promise.resolve({
                    matches: apiState.ytMatches,
                });
            },
        },
    },
});

beforeEach(() => {
    runtime.reset();
    loggerState.errors = [];

    apiState.tidalStatus = {
        enabled: true,
        available: true,
        authenticated: true,
    };
    apiState.ytStatus = {
        enabled: true,
        available: true,
        authenticated: true,
    };
    apiState.failTidalStatus = false;
    apiState.failYtStatus = false;
    apiState.rejectTidalBatch = false;
    apiState.rejectYtBatch = false;
    apiState.throwTidalBatch = false;
    apiState.throwYtBatch = false;
    apiState.tidalMatches = [];
    apiState.ytMatches = [];
    apiState.tidalPayloads = [];
    apiState.ytPayloads = [];
});

async function settleHook<T>(hookFn: () => T): Promise<T> {
    for (let pass = 0; pass < 5; pass += 1) {
        runtime.beginRender();
        hookFn();
        await runtime.flushEffects();
    }
    runtime.beginRender();
    return hookFn();
}

test("useYtMusicGapFill preserves exact matches and enriches remaining tracks", async () => {
    const { useYtMusicGapFill, invalidateYtMusicStatusCache } =
        await import("../../features/album/hooks/useYtMusicGapFill");
    invalidateYtMusicStatusCache();

    apiState.ytMatches = [{ videoId: "yt-101", title: "YT", duration: 222 }];

    const album = {
        id: "album-yt-1",
        title: "Album YT",
        artist: { id: "artist-1", name: "Artist One" },
        tracks: [
            {
                id: "track-youtube-exact",
                title: "Already YouTube",
                duration: 205,
                streamSource: "youtube",
                youtubeVideoId: "already-exact",
            },
            {
                id: "track-youtube",
                title: "Need YT",
                duration: 0,
                album: {},
            },
        ],
    };

    const result = await settleHook(() =>
        useYtMusicGapFill(album as any, "discovery"),
    );

    assert.equal(apiState.ytPayloads.length, 1);
    assert.equal(apiState.ytPayloads[0].length, 1);
    assert.equal(result.matchCount, 1);
    assert.equal(result.enrichedTracks?.[0].streamSource, "youtube");
    assert.equal(result.enrichedTracks?.[0].youtubeVideoId, "already-exact");
    assert.equal(result.enrichedTracks?.[1].streamSource, "youtube");
    assert.equal(result.enrichedTracks?.[1].youtubeVideoId, "yt-101");
    assert.equal(result.enrichedTracks?.[1].duration, 222);
});

test("useYtMusicGapFill logs and clears matches when batch match fails", async () => {
    const { useYtMusicGapFill, invalidateYtMusicStatusCache } =
        await import("../../features/album/hooks/useYtMusicGapFill");
    invalidateYtMusicStatusCache();
    apiState.rejectYtBatch = true;

    const result = await settleHook(() =>
        useYtMusicGapFill(
            {
                id: "album-yt-2",
                title: "Album YT Fail",
                tracks: [{ id: "track-1", title: "Track", duration: 210 }],
            },
            "library",
        ),
    );

    assert.equal(result.matchCount, 0);
    assert.equal(result.isMatching, false);
    assert.equal(
        loggerState.errors.some((entry) =>
            entry.includes("[YTMusic Gap-Fill] Batch match failed:"),
        ),
        true,
    );
});

test("useYtMusicTopTracks preserves exact matches and enriches unowned tracks", async () => {
    const { useYtMusicTopTracks } =
        await import("../../features/artist/hooks/useYtMusicTopTracks");

    apiState.ytMatches = [
        { videoId: "yt-artist-2", title: "YT", duration: 233 },
    ];

    const artist = {
        id: "artist-top-2",
        name: "Artist Two",
        topTracks: [
            {
                id: "youtube-exact-track",
                title: "YouTube exact",
                duration: 201,
                streamSource: "youtube",
                youtubeVideoId: "yt-existing",
                album: { id: "", title: "Unknown Album" },
            },
            {
                id: "yt-track",
                title: "Needs YT",
                duration: 0,
                album: { id: "", title: "Unknown Album" },
            },
            {
                id: "owned-track",
                title: "Owned",
                duration: 190,
                filePath: "/music/owned.flac",
                album: { id: "owned-1", title: "Owned Album" },
            },
            {
                id: "exact-yt-track",
                title: "Exact YouTube",
                duration: 240,
                streamSource: "youtube",
                youtubeVideoId: "already-exact",
                album: { id: "", title: "Unknown Album" },
            },
        ],
    };

    const result = await settleHook(() => useYtMusicTopTracks(artist as any));

    assert.equal(apiState.ytPayloads.at(-1)?.length, 1);
    assert.equal(result.matchCount, 1);
    assert.equal(result.enrichedTopTracks?.[0].streamSource, "youtube");
    assert.equal(result.enrichedTopTracks?.[0].youtubeVideoId, "yt-existing");
    assert.equal(result.enrichedTopTracks?.[1].streamSource, "youtube");
    assert.equal(result.enrichedTopTracks?.[1].youtubeVideoId, "yt-artist-2");
    assert.equal(result.enrichedTopTracks?.[1].duration, 233);
    assert.equal(result.enrichedTopTracks?.[2].streamSource, undefined);
    assert.equal(result.enrichedTopTracks?.[3].streamSource, "youtube");
    assert.equal(result.enrichedTopTracks?.[3].youtubeVideoId, "already-exact");
});

test("useYtMusicTopTracks matches metadata-only tracks even when their album is known", async () => {
    const { useYtMusicTopTracks } =
        await import("../../features/artist/hooks/useYtMusicTopTracks");

    apiState.ytMatches = [
        { videoId: "yt-cranberries-zombie", title: "Zombie", duration: 306 },
    ];

    const result = await settleHook(() =>
        useYtMusicTopTracks({
            id: "artist-cranberries",
            name: "The Cranberries",
            topTracks: [
                {
                    id: "track-zombie",
                    title: "Zombie",
                    duration: 306,
                    album: {
                        id: "album-no-need-to-argue",
                        title: "No Need to Argue",
                    },
                },
            ],
        } as any),
    );

    assert.equal(apiState.ytPayloads.at(-1)?.length, 1);
    assert.equal(result.matchCount, 1);
    assert.equal(result.enrichedTopTracks?.[0].streamSource, "youtube");
    assert.equal(
        result.enrichedTopTracks?.[0].youtubeVideoId,
        "yt-cranberries-zombie",
    );
});

test("useDiscoverProviderGapFill retires legacy sources when YouTube is unavailable", async () => {
    const { useDiscoverProviderGapFill } =
        await import("../../features/discover/hooks/useDiscoverProviderGapFill");

    apiState.tidalStatus = {
        enabled: true,
        available: false,
        authenticated: false,
    };
    apiState.ytStatus = {
        enabled: true,
        available: false,
        authenticated: false,
    };

    const tracks = [
        {
            id: "discover-1",
            title: "Track 1",
            artist: "Artist 1",
            album: "Album 1",
            albumId: "album-1",
            similarity: 0.9,
            tier: "high",
            coverUrl: null,
            available: true,
            duration: 200,
            isLiked: false,
            likedAt: null,
            sourceType: "tidal",
            streamSource: "tidal",
            tidalTrackId: 1,
        },
    ];

    const result = await settleHook(() =>
        useDiscoverProviderGapFill(tracks as any),
    );

    assert.equal(result.isMatching, false);
    assert.equal(result.tracks[0].sourceType, "local");
    assert.equal(result.tracks[0].streamSource, undefined);
    assert.equal(result.providerCounts.local, 1);
    assert.equal(result.providerCounts.youtube, 0);
});

test("useDiscoverProviderGapFill uses YouTube and handles matching errors", async () => {
    const { useDiscoverProviderGapFill } =
        await import("../../features/discover/hooks/useDiscoverProviderGapFill");

    apiState.tidalStatus = {
        enabled: true,
        available: true,
        authenticated: true,
    };
    apiState.ytStatus = { enabled: true, available: true, authenticated: true };
    apiState.ytMatches = [{ videoId: "yt-11" }, { videoId: "yt-22" }];
    const matchedInput = [
        {
            id: "discover-local",
            title: "Local",
            artist: "Artist Local",
            album: "Album Local",
            albumId: "album-local",
            similarity: 0.95,
            tier: "high",
            coverUrl: null,
            available: true,
            duration: 200,
            isLiked: false,
            likedAt: null,
        },
        {
            id: "discover-a",
            title: "A",
            artist: "Artist A",
            album: "Album A",
            albumId: "album-a",
            similarity: 0.91,
            tier: "high",
            coverUrl: null,
            available: false,
            duration: 210,
            isLiked: false,
            likedAt: null,
        },
        {
            id: "discover-b",
            title: "B",
            artist: "Artist B",
            album: "Album B",
            albumId: "album-b",
            similarity: 0.81,
            tier: "medium",
            coverUrl: null,
            available: false,
            duration: 211,
            isLiked: false,
            likedAt: null,
        },
    ];

    const matched = await settleHook(() =>
        useDiscoverProviderGapFill(matchedInput as any),
    );

    // Local track stays local, unavailable tracks get gap-filled
    assert.equal(matched.tracks[0].sourceType, "local");
    assert.equal(matched.tracks[1].sourceType, "youtube");
    assert.equal(matched.tracks[2].sourceType, "youtube");
    assert.equal(matched.providerCounts.local, 1);
    assert.equal(matched.providerCounts.youtube, 2);
    // Only unavailable tracks should be sent to batch matchers
    assert.equal(apiState.ytPayloads.at(-1)?.length, 2);

    runtime.reset();
    apiState.throwYtBatch = true;
    apiState.tidalPayloads = [];
    apiState.ytPayloads = [];
    const failedInput = [
        {
            id: "discover-error",
            title: "Err",
            artist: "Artist Err",
            album: "Album Err",
            albumId: "album-err",
            similarity: 0.5,
            tier: "explore",
            coverUrl: null,
            available: false,
            duration: 190,
            isLiked: false,
            likedAt: null,
        },
    ];

    const failed = await settleHook(() =>
        useDiscoverProviderGapFill(failedInput as any),
    );

    assert.equal(failed.tracks[0].sourceType, undefined);
    assert.equal(failed.tracks[0].available, false);
    assert.equal(loggerState.errors.length, 1);
});
