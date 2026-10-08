const mockNativeRadio = jest.fn(),
    mockExactNativeDislikes = jest.fn(),
    mockNativeCredits = jest.fn(),
    mockNativeQueued = jest.fn();
const mockLegacySeed = jest.fn(),
    mockRemoteSeed = jest.fn(),
    mockNativeMappings = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        track: { findMany: jest.fn() },
        artist: { findFirst: jest.fn(), findUnique: jest.fn() },
        dislikedEntity: { findMany: jest.fn(async () => []) },
    },
}));
jest.mock("../../musicSources/runtime", () => ({
    musicSourceCatalog: {
        recommendations: (...args: unknown[]) => mockNativeRadio(...args),
    },
}));
jest.mock("../nativeSourceAdmission", () => ({
    ...jest.requireActual("../nativeSourceAdmission"),
    loadDislikedNativeRecordingIds: (...args: unknown[]) =>
        mockExactNativeDislikes(...args),
    loadSuppressedNativeArtistCredits: (...args: unknown[]) =>
        mockNativeCredits(...args),
    loadVerifiedNativeCandidates: (...args: unknown[]) =>
        mockNativeQueued(...args),
}));
jest.mock("../../librarySeedRadio", () => ({
    selectLibrarySeedRadio: (...args: unknown[]) => mockLegacySeed(...args),
    LibrarySeedRadioError: class extends Error {},
}));
jest.mock("../../playlistRemoteRadio", () => ({
    buildRemoteTrackRadio: (...args: unknown[]) => mockRemoteSeed(...args),
    buildRemoteArtistRadio: jest.fn(),
}));
jest.mock("../../personalizedTrackPreferences", () => ({
    loadLibraryRepeatExclusions: jest.fn(async () => ({
        videoIds: new Set(),
        songKeys: new Set(),
    })),
    loadYouTubeRepeatExclusions: jest.fn(async () => ({
        videoIds: new Set(),
        songKeys: new Set(),
    })),
    loadSuppressedYouTubeArtists: jest.fn(
        async () => new Set(["artist, guest"]),
    ),
    loadDislikedYouTubeIds: jest.fn(async () => new Set()),
    loadRecentlyViewedCanonicalKeys: jest.fn(async () => new Set()),
}));
jest.mock("../verifiedSourceRepeats", () => ({
    loadVerifiedSourceRepeatExclusions: jest.fn(async () => ({
        ids: new Set(),
        hardIds: new Set(),
    })),
}));
jest.mock("../featureStore", () => ({
    recommendationFeatureStore: {
        loadDislikedCanonicalKeys: jest.fn(async () => new Set()),
    },
}));
jest.mock("../canonicalIdentity", () => ({
    ...jest.requireActual("../canonicalIdentity"),
    findMappedCanonicalCandidates: (...args: unknown[]) =>
        mockNativeMappings(...args),
}));
import { loadRadioContinuationCandidates } from "../radioContinuationRuntime";
import { toNativeRecommendationCandidate } from "../nativeCandidates";
import { createRadioRequestExecution } from "../radioRequestExecution";
import type { RadioContinuationInput } from "../radioContinuation";
const now = new Date("2026-10-08T12:00:00Z");
const recording = (
    provider: "vk" | "yandex",
    id: string,
    artists = ["Artist", "Guest"],
) => ({
    provider,
    id,
    title: `Song ${id}`,
    artists,
    duration: 180,
    contentVersion: "unknown" as const,
    preview: false,
});
const input: RadioContinuationInput = {
    userId: "alice",
    sessionId: "tab",
    cursor: 0,
    limit: 25,
    exclude: [],
    radioOrigin: { kind: "track", source: "vk", id: "-001_002" },
};
beforeEach(() => {
    jest.clearAllMocks();
    mockNativeRadio.mockResolvedValue({
        tracks: [recording("vk", "-1_3")],
        unavailable: [],
    });
    mockExactNativeDislikes.mockResolvedValue(new Set());
    mockNativeCredits.mockResolvedValue(new Set());
    mockNativeQueued.mockResolvedValue([]);
    mockNativeMappings.mockImplementation(async (candidates) =>
        candidates.map(() => null),
    );
});
describe("actual native original station runtime", () => {
    it.each(["vk", "yandex"] as const)(
        "loads %s exact seed with100raw without a legacy fallback",
        async (provider) => {
            const id = provider === "vk" ? "-001_002" : "0007";
            mockNativeRadio.mockResolvedValue({
                tracks: [
                    recording(provider, provider === "vk" ? "-1_3" : "0008"),
                ],
                unavailable: [],
            });
            const result = await loadRadioContinuationCandidates(
                {
                    ...input,
                    radioOrigin: { kind: "track", source: provider, id },
                },
                now,
            );
            expect(result.candidates.map((c) => c.id)).toEqual([
                provider === "vk" ? "vk:-1_3" : "yandex:0008",
            ]);
            expect(mockNativeRadio).toHaveBeenCalledWith(
                provider,
                id,
                100,
                expect.any(AbortSignal),
            );
            expect(mockLegacySeed).not.toHaveBeenCalled();
            expect(mockRemoteSeed).not.toHaveBeenCalled();
        },
    );
    it("applies exact unmapped downs and whole native credit before retaining fresh rows", async () => {
        mockNativeRadio.mockResolvedValue({
            tracks: [
                recording("vk", "-1_3"),
                recording("vk", "-1_4"),
                recording("vk", "-1_5", ["Fresh"]),
            ],
            unavailable: [],
        });
        mockExactNativeDislikes.mockResolvedValue(new Set(["vk:-1_3"]));
        mockNativeCredits.mockResolvedValue(
            new Set([JSON.stringify(["vk", ["artist", "guest"]])]),
        );
        const result = await loadRadioContinuationCandidates(input, now);
        expect(result.candidates.map((c) => c.id)).toEqual(["vk:-1_5"]);
        expect(mockExactNativeDislikes.mock.calls[0][0]).toBe("alice");
        expect(mockNativeCredits.mock.calls[0].slice(0, 2)).toEqual([
            "alice",
            now,
        ]);
    });
    it("excludes live canonical aliases of a confirmed native queued recording", async () => {
        const queued = toNativeRecommendationCandidate(
            recording("yandex", "0007"),
            "owned",
        )!;
        mockNativeQueued.mockResolvedValue([queued]);
        mockNativeMappings.mockImplementation(async (candidates) =>
            candidates.map((c: { id: string }) => ({
                id: "same",
                canonicalKey: "same",
            })),
        );
        expect(
            (
                await loadRadioContinuationCandidates(
                    { ...input, exclude: ["yandex:0007"] },
                    now,
                )
            ).candidates,
        ).toEqual([]);
        expect(mockNativeQueued).toHaveBeenCalledWith(
            expect.arrayContaining(["yandex:0007"]),
            undefined,
        );
    });
    it("blocks exact unmapped owner dislikes independently of artist suppression and retains later fresh rows", async () => {
        mockNativeRadio.mockResolvedValue({
            tracks: Array.from({ length: 100 }, (_, i) =>
                recording("yandex", String(i + 1), [`Credit ${i + 1}`]),
            ),
            unavailable: [],
        });
        mockExactNativeDislikes.mockResolvedValue(
            new Set(Array.from({ length: 50 }, (_, i) => `yandex:${i + 1}`)),
        );
        const result = await loadRadioContinuationCandidates(
            {
                ...input,
                radioOrigin: { kind: "track", source: "yandex", id: "0007" },
            },
            now,
        );
        expect(result.candidates.length).toBeGreaterThanOrEqual(25);
        expect(
            result.candidates.every(
                (c) => Number(c.musicSourceRecording?.id) > 50,
            ),
        ).toBe(true);
        expect(mockNativeCredits).toHaveReturned();
        expect(mockNativeMappings.mock.results.length).toBeGreaterThan(0);
    });
    it.each(["empty", "unavailable", "error"])(
        "preserves native origin on %s without borrowing library music",
        async (kind) => {
            if (kind === "error")
                mockNativeRadio.mockRejectedValue(
                    new Error("private upstream body"),
                );
            else
                mockNativeRadio.mockResolvedValue({
                    tracks: [],
                    unavailable: kind === "unavailable" ? ["vk"] : [],
                });
            const result = await loadRadioContinuationCandidates(input, now);
            expect(result.candidates).toEqual([]);
            expect(result.degradedSources.includes("vk-radio")).toBe(
                kind !== "empty",
            );
            expect(mockLegacySeed).not.toHaveBeenCalled();
            expect(mockRemoteSeed).not.toHaveBeenCalled();
        },
    );
    it.each(["artist", "exact"])(
        "keeps native candidates out if the %s owner preference read fails",
        async (kind) => {
            (kind === "artist"
                ? mockNativeCredits
                : mockExactNativeDislikes
            ).mockRejectedValue(new Error("unavailable"));
            const result = await loadRadioContinuationCandidates(input, now);
            expect(result.candidates).toEqual([]);
            expect(result.degradedSources).toContain(
                kind === "artist"
                    ? "radio-native-artist-preferences"
                    : "radio-native-dislikes",
            );
        },
    );
    it("forwards cancellation and cannot continue native admission after a held source returns", async () => {
        const controller = new AbortController(),
            execution = createRadioRequestExecution(controller.signal);
        let finish!: (value: unknown) => void,
            started!: (value?: unknown) => void;
        const ready = new Promise((resolve) => {
            started = resolve;
        });
        mockNativeRadio.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                    started();
                }),
        );
        const work = loadRadioContinuationCandidates(
            { ...input, execution, sourceSignal: controller.signal },
            now,
        ).catch((error) => error);
        await ready;
        const signal = mockNativeRadio.mock.calls[0][3] as AbortSignal;
        controller.abort();
        expect(signal.aborted).toBe(true);
        finish({ tracks: [recording("vk", "-1_3")], unavailable: [] });
        expect(await work).toMatchObject({ code: "RADIO_REQUEST_CANCELLED" });
        expect(mockExactNativeDislikes).not.toHaveBeenCalled();
        execution.dispose();
    });
});
