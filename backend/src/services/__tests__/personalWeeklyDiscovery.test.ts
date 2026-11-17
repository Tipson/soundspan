jest.mock("../youtubeMusic", () => ({ ytMusicService: {} }));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../recommendations/listenBrainzAdapter", () => ({
    listenBrainzRecommendationAdapter: {},
}));

import { PersonalWeeklyDiscoveryService } from "../personalWeeklyDiscovery";
import type {
    WeeklyDiscoveryTrack,
    StoredWeeklyDiscovery,
} from "../weeklyDiscoveryStore";

function track(
    n: number,
): Extract<WeeklyDiscoveryTrack, { sourceType: "youtube" }> {
    return {
        id: `yt:video-${n}`,
        youtubeVideoId: `video-${n}`,
        title: `Song ${n}`,
        artist: `Artist ${Math.floor(n / 2)}`,
        album: "Album",
        albumId: `album-${n}`,
        duration: 180,
        coverUrl: null,
        sourceType: "youtube",
        streamSource: "youtube",
        available: true,
        isLiked: false,
        likedAt: null,
        similarity: 0,
        tier: "explore",
    };
}
function fixture() {
    let now = new Date("2026-10-07T12:00:00Z");
    const rows = new Map<string, StoredWeeklyDiscovery>();
    const store = {
        find: jest.fn(
            async (user: string, week: string) =>
                rows.get(`${user}:${week}`) ?? null,
        ),
        save: jest.fn(
            async (
                user: string,
                week: string,
                tracks: WeeklyDiscoveryTrack[],
            ) => {
                const key = `${user}:${week}`;
                const saved = rows.get(key) ?? {
                    id: key,
                    weekStart: week,
                    tracks,
                    cleared: false,
                    generatedAt: now.toISOString(),
                };
                rows.set(key, saved);
                return saved;
            },
        ),
        clear: jest.fn(async (user: string, week: string) => {
            const key = `${user}:${week}`;
            const count = rows.get(key)?.tracks.length ?? 0;
            rows.set(key, {
                id: key,
                weekStart: week,
                tracks: [],
                cleared: true,
            });
            return count;
        }),
    };
    const dependencies = {
        store,
        getCandidates: jest.fn(async () =>
            Array.from({ length: 40 }, (_, i) => track(i)),
        ),
        loadNoveltyExclusions: jest.fn(async () => new Set<string>()),
        loadDislikedIds: jest.fn(async () => new Set<string>()),
        loadSuppressedArtistKeys: jest.fn(async () => new Set<string>()),
        filterCurrentFeedback: jest.fn(
            async (_owner: string, tracks: WeeklyDiscoveryTrack[]) => tracks,
        ),
        now: () => now,
    };
    return {
        service: new PersonalWeeklyDiscoveryService(dependencies),
        dependencies,
        setNow: (date: string) => {
            now = new Date(date);
        },
    };
}

describe("online weekly discoveries", () => {
    it("does not label a healthy native feedback exclusion as provider downtime", async () => {
        const f = fixture();
        const original = await f.service.getCurrent("alice");
        const current = await new PersonalWeeklyDiscoveryService({
            ...f.dependencies,
            filterNativeCandidates: async (_owner, tracks) => tracks.slice(1),
        }).getCurrent("alice");
        expect(current.tracks.map((track) => track.id)).toEqual(
            original.tracks.slice(1).map((track) => track.id),
        );
        expect(current.snapshot).toMatchObject({
            generatedAt: original.snapshot!.generatedAt,
            snapshotCount: 40,
            availableCount: 39,
            reasons: ["feedback_filtered"],
        });
        expect(f.dependencies.getCandidates).toHaveBeenCalledTimes(1);
    });
    it("keeps explicit native admission outage separate from feedback", async () => {
        const f = fixture();
        const original = await f.service.getCurrent("alice");
        const current = await new PersonalWeeklyDiscoveryService({
            ...f.dependencies,
            filterNativeCandidates: async (_owner, tracks) => ({
                tracks: tracks.slice(1),
                providerDegraded: true,
            }),
        }).getCurrent("alice");
        expect(current.tracks.map((track) => track.id)).toEqual(
            original.tracks.slice(1).map((track) => track.id),
        );
        expect(current.snapshot).toMatchObject({
            generatedAt: original.snapshot!.generatedAt,
            snapshotCount: 40,
            availableCount: 39,
            reasons: ["provider_degraded"],
        });
        expect(f.dependencies.getCandidates).toHaveBeenCalledTimes(1);
    });
    it("keeps current cross-provider admission outage separate from a taste exclusion", async () => {
        const f = fixture();
        const original = await f.service.getCurrent("alice");
        const current = await new PersonalWeeklyDiscoveryService({
            ...f.dependencies,
            filterCurrentFeedback: async (_owner, tracks) => ({
                tracks: tracks.slice(1),
                providerDegraded: true,
            }),
        }).getCurrent("alice");
        expect(current.tracks.map((track) => track.id)).toEqual(
            original.tracks.slice(1).map((track) => track.id),
        );
        expect(current.snapshot).toMatchObject({
            snapshotCount: 40,
            availableCount: 39,
            reasons: ["provider_degraded"],
        });
    });
    it("preserves snapshot time and original count after current feedback filters the saved week", async () => {
        const f = fixture();
        const first = await f.service.getCurrent("alice");
        expect(first.snapshot).toEqual({
            generatedAt: "2026-10-07T12:00:00.000Z",
            weekStart: "2026-10-05T00:00:00.000Z",
            weekEnd: "2026-10-11T23:59:59.999Z",
            refreshAfter: "2026-10-12T00:00:00.000Z",
            requestedCount: 40,
            snapshotCount: 40,
            availableCount: 40,
            reasons: [],
        });
        f.setNow("2026-10-10T22:00:00Z");
        f.dependencies.filterCurrentFeedback.mockImplementation(
            async (_owner, tracks) => tracks.slice(1),
        );
        const filtered = await f.service.getCurrent("alice");
        expect(filtered.snapshot).toEqual({
            ...first.snapshot,
            availableCount: 39,
            reasons: ["feedback_filtered"],
        });
    });

    it("does not invent a generation date for a legacy stored week", async () => {
        const f = fixture();
        f.dependencies.store.find.mockResolvedValue({
            id: "legacy",
            weekStart: "2026-10-05T00:00:00.000Z",
            cleared: false,
            tracks: Array.from({ length: 20 }, (_, i) => track(i)),
        });
        const result = await f.service.getCurrent("alice");
        expect(result.snapshot).toMatchObject({
            snapshotCount: 20,
            availableCount: 20,
            reasons: ["pool_limited"],
        });
        expect(result.snapshot!.generatedAt).toBeUndefined();
    });

    it("reports the snapshot that wins a concurrent save rather than the discarded degraded attempt", async () => {
        const f = fixture();
        const saved = {
            id: "winner",
            weekStart: "2026-10-05T00:00:00.000Z",
            cleared: false,
            generatedAt: "2026-10-06T07:00:00.000Z",
            tracks: Array.from({ length: 40 }, (_, i) => track(i)),
        };
        const service = new PersonalWeeklyDiscoveryService({
            ...f.dependencies,
            getCandidates: async () => ({
                tracks: saved.tracks,
                providerDegraded: true,
            }),
            store: { ...f.dependencies.store, save: async () => saved },
        });
        const result = await service.getCurrent("alice");
        expect(result.generationId).toBe("winner");
        expect(result.snapshot).toMatchObject({
            generatedAt: "2026-10-06T07:00:00.000Z",
            reasons: [],
        });
    });

    it("distinguishes a short observed pool from a failed generation without inventing a snapshot", async () => {
        const f = fixture();
        f.dependencies.getCandidates.mockResolvedValue(
            Array.from({ length: 19 }, (_, i) => track(i)),
        );
        const limited = await f.service.getCurrent("alice");
        expect(limited.snapshot).toMatchObject({
            snapshotCount: 0,
            availableCount: 0,
            reasons: ["pool_limited"],
        });
        expect(limited.snapshot!.generatedAt).toBeUndefined();
        f.dependencies.getCandidates.mockRejectedValue(
            new Error("provider secret"),
        );
        const failed = await f.service.getCurrent("alice");
        expect(failed.snapshot).toMatchObject({
            snapshotCount: 0,
            availableCount: 0,
            reasons: ["provider_degraded"],
        });
        expect(failed.snapshot!.generatedAt).toBeUndefined();
        expect(JSON.stringify(failed)).not.toContain("provider secret");
    });
    it("re-admits saved tracks against current feedback without reranking, refill, or another generation", async () => {
        const f = fixture();
        const original = await f.service.getCurrent("alice");
        const rejected = new Set([
            original.tracks[1].id,
            original.tracks[3].id,
        ]);
        f.dependencies.filterCurrentFeedback.mockImplementation(
            async (owner, tracks) =>
                owner === "alice"
                    ? tracks.filter((entry) => !rejected.has(entry.id))
                    : tracks,
        );
        const current = await f.service.getCurrent("alice");
        const trace = Reflect.get(
            globalThis,
            "__DEV09_IDENTITY_FIXTURE_TRACE__",
        );
        if (typeof trace === "function")
            trace({
                kind: "saved-week-contract",
                scenario: expect.getState().currentTestName,
                userId: "alice",
                requested: original.tracks.map((entry) => entry.id),
                admitted: current.tracks.map((entry) => entry.id),
                fixtureBlocked: current.tracks
                    .filter((entry) => rejected.has(entry.id))
                    .map((entry) => entry.id),
                exact: null,
                verified: null,
                unresolved: null,
                unavailable: null,
            });
        expect(current.tracks.map((entry) => entry.id)).toEqual(
            original.tracks
                .filter((entry) => !rejected.has(entry.id))
                .map((entry) => entry.id),
        );
        expect(current.count).toBe(38);
        expect(current.totalCount).toBe(38);
        expect(f.dependencies.getCandidates).toHaveBeenCalledTimes(1);
        expect(f.dependencies.store.save).toHaveBeenCalledTimes(1);
        expect((await f.service.getCurrent("bob")).count).toBe(40);
        f.dependencies.filterCurrentFeedback.mockResolvedValue([]);
        const empty = await f.service.getCurrent("alice");
        expect(empty.tracks).toEqual([]);
        expect(empty.count).toBe(0);
        expect(f.dependencies.getCandidates).toHaveBeenCalledTimes(2);
        expect(f.dependencies.store.save).toHaveBeenCalledTimes(2);
    });

    it("persists 40 tracks and one owned generation for the whole UTC week", async () => {
        const f = fixture();
        const first = await f.service.getCurrent("alice");
        expect(first.tracks).toHaveLength(40);
        expect(first.weekStart.toISOString()).toBe("2026-10-05T00:00:00.000Z");
        expect(
            first.tracks.every(
                (t) => t.recommendationGenerationId === first.generationId,
            ),
        ).toBe(true);
        f.setNow("2026-10-11T23:59:59Z");
        expect(await f.service.getCurrent("alice")).toEqual(first);
        expect(f.dependencies.getCandidates).toHaveBeenCalledTimes(1);
        f.setNow("2026-10-12T00:00:00Z");
        expect((await f.service.getCurrent("alice")).generationId).not.toBe(
            first.generationId,
        );
        expect((await f.service.getCurrent("bob")).generationId).not.toBe(
            first.generationId,
        );
    });
    it("coalesces simultaneous generation, but rechecks dislikes on every read", async () => {
        const f = fixture();
        await Promise.all([
            f.service.getCurrent("alice"),
            f.service.getCurrent("alice"),
        ]);
        expect(f.dependencies.store.save).toHaveBeenCalledTimes(1);
        f.dependencies.loadDislikedIds.mockResolvedValue(new Set(["video-0"]));
        f.dependencies.loadSuppressedArtistKeys.mockResolvedValue(
            new Set(["artist 1"]),
        );
        const current = await f.service.getCurrent("alice");
        expect(current.tracks.map((t) => t.youtubeVideoId)).not.toContain(
            "video-0",
        );
        expect(current.tracks.map((t) => t.artist)).not.toContain("Artist 1");
        expect(current.tracks[0].youtubeVideoId).toBe("video-1");
        expect(f.dependencies.getCandidates).toHaveBeenCalledTimes(1);
    });
    it("does not remove a saved discovery when it becomes familiar", async () => {
        const f = fixture();
        const first = await f.service.getCurrent("alice");
        f.dependencies.loadNoveltyExclusions.mockResolvedValue(
            new Set(["video-0"]),
        );
        expect(await f.service.getCurrent("alice")).toEqual(first);
    });
    it("excludes known songs, duplicate recordings and suppressed artists before saving", async () => {
        const f = fixture();
        f.dependencies.getCandidates
            .mockResolvedValueOnce([
                track(0),
                {
                    ...track(0),
                    id: "yt:alternate",
                    youtubeVideoId: "alternate",
                    title: "SONG 0",
                },
                ...Array.from({ length: 38 }, (_, i) => track(i + 1)),
            ])
            .mockResolvedValueOnce([track(39)]);
        f.dependencies.loadNoveltyExclusions.mockResolvedValue(
            new Set(["video-2"]),
        );
        const result = await f.service.getCurrent("alice");
        expect(result.tracks).toHaveLength(39);
        expect(result.tracks.map((t) => t.youtubeVideoId)).not.toContain(
            "alternate",
        );
        expect(result.tracks.map((t) => t.youtubeVideoId)).not.toContain(
            "video-2",
        );
    });
    it("never saves a short or failed result, and permits a later retry", async () => {
        const f = fixture();
        f.dependencies.getCandidates.mockResolvedValue([track(0)]);
        expect((await f.service.getCurrent("alice")).tracks).toEqual([]);
        expect(f.dependencies.store.save).not.toHaveBeenCalled();
        expect(f.dependencies.getCandidates).toHaveBeenCalledTimes(2);
        f.dependencies.getCandidates.mockRejectedValue(new Error("offline"));
        expect((await f.service.getCurrent("alice")).tracks).toEqual([]);
        f.dependencies.getCandidates.mockResolvedValue(
            Array.from({ length: 40 }, (_, i) => track(i)),
        );
        expect((await f.service.getCurrent("alice")).tracks).toHaveLength(40);
    });
    it("explicit clear leaves an empty tombstone until the following week", async () => {
        const f = fixture();
        await f.service.getCurrent("alice");
        expect(await f.service.clearCurrent("alice")).toBe(40);
        expect((await f.service.getCurrent("alice")).tracks).toEqual([]);
        expect(f.dependencies.getCandidates).toHaveBeenCalledTimes(1);
    });
    it("a read started after clear never joins an old snapshot lookup", async () => {
        const f = fixture();
        await f.service.getCurrent("alice");
        const old = await f.dependencies.store.find(
            "alice",
            "2026-10-05T00:00:00.000Z",
        );
        let release!: (snapshot: StoredWeeklyDiscovery | null) => void;
        f.dependencies.store.find.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const stale = f.service.getCurrent("alice");
        await f.service.clearCurrent("alice");
        const fresh = f.service.getCurrent("alice");
        release(old);
        await stale;
        expect((await fresh).tracks).toEqual([]);
    });
    it("a clear in another API process wins over this process's pending lookup", async () => {
        const f = fixture();
        await f.service.getCurrent("alice");
        const old = await f.dependencies.store.find(
            "alice",
            "2026-10-05T00:00:00.000Z",
        );
        let release!: (snapshot: StoredWeeklyDiscovery | null) => void;
        f.dependencies.store.find.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const stale = f.service.getCurrent("alice");
        const otherProcess = new PersonalWeeklyDiscoveryService(f.dependencies);
        await otherProcess.clearCurrent("alice");
        const fresh = f.service.getCurrent("alice");
        release(old);
        await stale;
        expect((await fresh).tracks).toHaveLength(0);
    });
    it("does not save a provider response that finishes after the deadline", async () => {
        jest.useFakeTimers();
        try {
            const f = fixture();
            let resolve!: (
                tracks: Extract<
                    WeeklyDiscoveryTrack,
                    { sourceType: "youtube" }
                >[],
            ) => void;
            f.dependencies.getCandidates.mockImplementation(
                () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            );
            const pending = f.service.getCurrent("alice");
            await jest.advanceTimersByTimeAsync(12_001);
            expect((await pending).tracks).toEqual([]);
            resolve(Array.from({ length: 40 }, (_, i) => track(i)));
            await jest.advanceTimersByTimeAsync(1);
            expect(f.dependencies.store.save).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});
