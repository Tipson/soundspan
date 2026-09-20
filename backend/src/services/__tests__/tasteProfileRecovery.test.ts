jest.mock("../youtubeMusic", () => ({ ytMusicService: {} }));
jest.mock("../../utils/db", () => ({ prisma: {} }));
import {
    TasteProfileService,
    type TasteProfilePersistenceState,
    type TasteProfileDependencies,
} from "../tasteProfile";

function fixture() {
    let state: TasteProfilePersistenceState = {
        tasteProfile: null,
        tasteProfileCompletedAt: null,
        tasteProfileSkippedAt: null,
    };
    let time = Date.parse("2026-09-20T12:00:00Z");
    const searchSongs = jest.fn(async (_user: string, query: string) => [
        {
            providerTrackId: query.replace(/\W/g, ""),
            title: query,
            artistName: "Artist",
            albumTitle: null,
            durationSec: 180,
            thumbnailUrl: null,
        },
    ]);
    const deps: TasteProfileDependencies = {
        loadState: async () => state,
        hasMeaningfulSignals: async () => false,
        saveState: async (_user, write) => (state = write),
        updateRecoveredState: async (_user, expected, profile) => {
            if (JSON.stringify(state.tasteProfile) !== JSON.stringify(expected))
                return false;
            state = { ...state, tasteProfile: profile };
            return true;
        },
        searchSongs,
        now: () => new Date(time),
    };
    return {
        service: new TasteProfileService(deps),
        deps,
        searchSongs,
        advance: () => {
            time += 61_000;
        },
        state: () => state,
    };
}
const selection = { genres: ["Rock"], artists: ["Muse", "Queen"] };
describe("durable taste seed recovery", () => {
    it("coalesces concurrent reads and preserves newer choices during a retry", async () => {
        const f = fixture();
        f.searchSongs.mockRejectedValue(new Error("offline"));
        await f.service.saveProfile("alice", selection);
        f.advance();
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        f.searchSongs.mockImplementation(async () => {
            await pending;
            return [];
        });
        const reads = [
            f.service.getProfile("alice"),
            f.service.getProfile("alice"),
        ];
        await Promise.resolve();
        await Promise.resolve();
        expect(f.searchSongs).toHaveBeenCalledTimes(6);
        await f.deps.saveState("alice", {
            tasteProfile: {
                ...selection,
                artists: ["New Artist"],
                seedTracks: [],
                resolution: {
                    pendingQueries: ["New Artist songs"],
                    attempts: 1,
                    retryAfter: new Date().toISOString(),
                },
            },
            tasteProfileCompletedAt: new Date(),
            tasteProfileSkippedAt: null,
        });
        release();
        const results = await Promise.all(reads);
        expect(
            results.every(
                (result) => result.profile?.artists[0] === "New Artist",
            ),
        ).toBe(true);
    });
    it("preserves choices during total outage, retries on a later read and survives service recreation", async () => {
        const f = fixture();
        f.searchSongs.mockRejectedValue(new Error("unavailable"));
        const saved = await f.service.saveProfile("alice", selection);
        expect(saved.profile).toMatchObject({
            ...selection,
            seedTracks: [],
            resolution: {
                pendingQueries: ["Rock music", "Muse songs", "Queen songs"],
            },
        });
        expect(saved.needsOnboarding).toBe(false);
        await f.service.getProfile("alice");
        expect(f.searchSongs).toHaveBeenCalledTimes(3);
        f.searchSongs.mockImplementation(async (_user, query) => [
            {
                providerTrackId: query.replace(/\W/g, ""),
                title: query,
                artistName: "Artist",
                albumTitle: null,
                durationSec: 180,
                thumbnailUrl: null,
            },
        ]);
        f.advance();
        const recovered = await new TasteProfileService(f.deps).getProfile(
            "alice",
        );
        expect(recovered.profile?.seedTracks).toHaveLength(3);
        expect(recovered.profile?.resolution).toBeUndefined();
    });
    it("retries failed queries only and limits repeated failure", async () => {
        const f = fixture();
        f.searchSongs.mockRejectedValueOnce(new Error("offline"));
        const saved = await f.service.saveProfile("alice", selection);
        expect(saved.profile?.seedTracks).toHaveLength(2);
        f.searchSongs.mockRejectedValue(new Error("offline"));
        for (let i = 0; i < 5; i++) {
            f.advance();
            await f.service.getProfile("alice");
        }
        expect(f.searchSongs).toHaveBeenCalledTimes(5);
        expect(f.state().tasteProfile).toMatchObject({
            resolution: { attempts: 3 },
            seedTracks: expect.any(Array),
        });
    });
    it("does not overwrite a skip that occurs during recovery", async () => {
        const f = fixture();
        f.searchSongs.mockRejectedValue(new Error("offline"));
        await f.service.saveProfile("alice", selection);
        f.advance();
        f.searchSongs.mockImplementation(async () => {
            await f.service.skipProfile("alice");
            return [];
        });
        const result = await f.service.getProfile("alice");
        expect(result.profile).toBeNull();
        expect(result.skippedAt).not.toBeNull();
    });
});
