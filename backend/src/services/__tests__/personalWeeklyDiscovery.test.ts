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

function track(n: number): WeeklyDiscoveryTrack {
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
            let resolve!: (tracks: WeeklyDiscoveryTrack[]) => void;
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
