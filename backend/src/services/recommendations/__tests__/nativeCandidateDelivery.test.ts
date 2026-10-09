const mockMappingRows = jest.fn();
const mockCanonicalRow = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        trackMapping: { findMany: mockMappingRows },
        canonicalRecording: { findUnique: mockCanonicalRow },
    },
}));
import { RecommendationEngine } from "../engine";
import { RecommendationExposureStore } from "../exposureStore";
import {
    findMappedCanonicalCandidates,
    CanonicalIdentityResolver,
} from "../canonicalIdentity";
import { toRadioContinuationTrack } from "../radioContinuation";
import { rankRecommendationCandidates } from "../rankerV2";
import { toNativeRecommendationCandidate } from "../nativeCandidates";
import type { RecommendationCandidate } from "../types";

const NOW = new Date("2026-10-08T12:00:00Z");
function native(
    provider: "vk" | "yandex",
    rawId = provider === "vk" ? "-001_002" : "0007",
): RecommendationCandidate {
    return {
        id: `${provider}:${rawId}`,
        canonicalKey: `provider:${provider}:${rawId}`,
        title: "Confirmed song",
        duration: 180,
        artist: { id: null, name: "Artist, Guest" },
        album: { id: null, title: "", coverArt: null },
        source: provider,
        streamSource: provider,
        provider: {
            source: provider,
            providerTrackId: rawId,
            tidalTrackId: null,
            youtubeVideoId: null,
        },
        musicSourceRecording: {
            provider,
            id: rawId,
            title: "Confirmed song",
            artists: ["Artist", "Guest"],
            duration: 180,
            contentVersion: "unknown",
            preview: false,
        },
        candidateSources: ["native-radio"],
        providerPrior: 1,
        lane: "discovery",
    };
}
function dependencies(mode: "baseline" | "shadow" | "active") {
    return {
        mode,
        hybridRolloutPercent: 100,
        explorationRate: 0,
        loadCandidates: jest.fn().mockResolvedValue({
            candidates: [native("vk"), native("yandex")],
            nextCursor: 1,
            degradedSources: [],
        }),
        resolveCanonical: async (track: RecommendationCandidate) => ({
            id: `canonical-${track.id}`,
            canonicalKey: track.canonicalKey,
        }),
        loadRecentExposures: async () => [],
        loadDislikedCanonicalKeys: async () => new Set<string>(),
        loadTasteContext: async () => ({
            positiveCentroids: [],
            negativeCentroids: [],
        }),
        recordGeneration: jest.fn().mockResolvedValue("generation"),
        scheduleHotSet: jest.fn().mockResolvedValue(undefined),
        now: () => NOW,
    };
}
const request = {
    userId: "alice",
    sessionId: "tab",
    intent: {
        surface: "wave" as const,
        direction: "for-you" as const,
        mood: null,
    },
    limit: 2,
};

describe("native recommendation delivery", () => {
    beforeEach(() => {
        mockMappingRows.mockReset();
        mockCanonicalRow.mockReset();
    });
    it("rejects invalid native identities before exploration can reinsert them", () => {
        const malformed = {
            ...native("vk"),
            id: "vk:-002_003",
            providerPrior: 100,
        };
        const familiar = [native("yandex", "1"), native("yandex", "2")].map(
            (c, i) => ({
                ...c,
                lane: "listenAgain" as const,
                artist: { id: null, name: `Artist ${i}` },
                musicSourceRecording: {
                    ...c.musicSourceRecording!,
                    artists: [`Artist ${i}`],
                },
            }),
        );
        const result = rankRecommendationCandidates([...familiar, malformed], {
            now: NOW,
            limit: 2,
            sessionId: "tab",
            direction: "for-you",
            mood: null,
            dislikedCanonicalKeys: new Set(),
            exposures: [],
            positiveCentroids: [],
            negativeCentroids: [],
            explorationRate: 0.3,
        });
        expect(new Set(result.map((r) => r.track.id))).toEqual(
            new Set(familiar.map((c) => c.id)),
        );
    });
    it.each(["baseline", "shadow", "active"] as const)(
        "retains neutral exact identity and strips untrusted authority in %s",
        async (mode) => {
            const deps = {
                ...dependencies(mode),
                resolveCanonical: jest.fn().mockResolvedValue(null),
            };
            const poisoned = {
                ...native("vk"),
                canonicalKey: "yt:forged-key",
                canonicalRecordingId: "someone-else",
                isrc: "FAKE",
                embedding: [1, 0],
                audioFeatures: { energy: 1 },
            };
            deps.loadCandidates.mockResolvedValue({
                candidates: [poisoned],
                nextCursor: 1,
                degradedSources: [],
            });
            const result = await new RecommendationEngine(deps).recommend(
                request,
            );
            expect(result.tracks).toHaveLength(1);
            expect(result.tracks[0]).toMatchObject({
                id: "vk:-001_002",
                canonicalKey: "provider:vk:-001_002",
                canonicalRecordingId: null,
            });
            expect(result.tracks[0]).not.toHaveProperty("embedding");
            expect(result.tracks[0]).not.toHaveProperty("audioFeatures");
            expect(result.tracks[0]).not.toHaveProperty("isrc");
            expect(result.degradedSources).not.toContain("canonical-identity");
        },
    );
    it.each([
        { id: "vk:-1_2" },
        { source: "library" },
        { streamSource: "youtube" },
        {
            provider: {
                source: "yandex",
                providerTrackId: "0007",
                youtubeVideoId: null,
                tidalTrackId: null,
            },
        },
        { youtubeVideoId: "abcdefghi01" },
        { duration: 181 },
        { title: "Other title" },
        { artist: { id: null, name: "Guest, Artist" } },
    ] as Partial<RecommendationCandidate>[])(
        "drops inconsistent identity %j before mapping or hot-set",
        async (overrides) => {
            const deps = {
                ...dependencies("active"),
                resolveCanonical: jest.fn(),
            };
            deps.loadCandidates.mockResolvedValue({
                candidates: [{ ...native("vk"), ...overrides }],
                nextCursor: 1,
                degradedSources: [],
            });
            const result = await new RecommendationEngine(deps).recommend(
                request,
            );
            expect(result.tracks).toEqual([]);
            expect(deps.resolveCanonical).not.toHaveBeenCalled();
            expect(
                deps.recordGeneration.mock.calls.every(
                    ([g]) => g.recommendations.length === 0,
                ),
            ).toBe(true);
        },
    );
    it("builds sanitized metadata without private or asserted measured fields", () => {
        const value = {
            ...native("yandex").musicSourceRecording!,
            url: "https://secret.invalid",
            token: "secret",
            canonicalRecordingId: "claimed",
            embedding: [1, 0],
        };
        const candidate = toNativeRecommendationCandidate(
            value,
            "native-radio",
        )!;
        expect(candidate.canonicalRecordingId).toBeNull();
        expect(candidate.musicSourceRecording).toEqual(
            native("yandex").musicSourceRecording,
        );
        expect(JSON.stringify(candidate)).not.toMatch(
            /secret|claimed|embedding/,
        );
        expect(
            toNativeRecommendationCandidate(
                { ...value, preview: true },
                "native-radio",
            ),
        ).toBeNull();
    });
    it.each(["baseline", "shadow", "active"] as const)(
        "serves coherent exact native identities in %s and retains served membership",
        async (mode) => {
            const deps = dependencies(mode),
                result = await new RecommendationEngine(deps).recommend(
                    request,
                );
            expect(new Set(result.tracks.map((t) => t.id))).toEqual(
                new Set(["vk:-001_002", "yandex:0007"]),
            );
            for (const [generation] of deps.recordGeneration.mock.calls.filter(
                ([generation]) => generation.served,
            ))
                expect(
                    new Set(
                        generation.recommendations.map(
                            (r: { track: RecommendationCandidate }) =>
                                r.track.id,
                        ),
                    ),
                ).toEqual(new Set(result.tracks.map((t) => t.id)));
        },
    );
    it.each([
        { provider: "youtube" },
        { providerTrackId: "7" },
        { metadataObservedAt: null },
        { metadataConnectionVersion: 0 },
        { verifiedMetadata: null },
        {
            verifiedMetadata: {
                ...native("yandex").musicSourceRecording!,
                id: "8",
            },
        },
        {
            verifiedMetadata: {
                ...native("yandex").musicSourceRecording!,
                preview: true,
            },
        },
    ])(
        "keeps incomplete or inconsistent attestation neutral: %j",
        async (override) => {
            mockMappingRows.mockResolvedValue([
                {
                    track: null,
                    trackYtMusic: null,
                    trackTidal: null,
                    trackMusicSource: {
                        provider: "yandex",
                        providerTrackId: "0007",
                        verifiedMetadata: native("yandex").musicSourceRecording,
                        metadataObservedAt: NOW,
                        metadataConnectionVersion: 7,
                        ...override,
                    },
                    canonicalRecording: {
                        id: "wrong",
                        canonicalKey: "claimed",
                        mergedIntoId: null,
                        identitySource: "verified-source",
                    },
                },
            ]);
            expect(
                await findMappedCanonicalCandidates([native("yandex")]),
            ).toEqual([null]);
            expect(mockCanonicalRow).not.toHaveBeenCalled();
        },
    );
    it("does not reinterpret reserved native IDs as library IDs", async () => {
        const candidate = { ...native("vk"), source: "library" as const };
        expect(await findMappedCanonicalCandidates([candidate])).toEqual([
            null,
        ]);
        expect(mockMappingRows).not.toHaveBeenCalled();
        const deps = {
            findProviderMapping: jest.fn(),
            findCanonical: jest.fn(),
            upsertCanonical: jest.fn(),
            attachProviderMapping: jest.fn(),
        };
        await expect(
            new CanonicalIdentityResolver(deps).resolve(candidate),
        ).rejects.toThrow();
        expect(deps.findProviderMapping).not.toHaveBeenCalled();
    });
    it.each(["vk", "yandex"] as const)(
        "records %s provider attribution without a fabricated canonical FK",
        async (provider) => {
            const createGeneration = jest
                .fn()
                .mockResolvedValue({ id: "native-generation" });
            const store = new RecommendationExposureStore({
                createGeneration,
                loadRecentExposures: jest.fn(),
                findAttributableExposure: jest.fn(),
                updateExposure: jest.fn(),
            });
            const track = native(provider);
            await store.record({
                userId: "alice",
                sessionId: "tab",
                surface: "wave",
                direction: "for-you",
                mood: null,
                cursor: 0,
                algorithm: "baseline-v1",
                served: true,
                degradedSources: [],
                latencyMs: 1,
                recommendations: [{ track, score: 1 }],
            });
            expect(createGeneration.mock.calls[0][0].exposures).toEqual([
                expect.objectContaining({
                    provider,
                    providerTrackId: provider === "vk" ? "-001_002" : "0007",
                    canonicalRecordingId: null,
                    canonicalKey: track.canonicalKey,
                }),
            ]);
            expect(
                JSON.stringify(createGeneration.mock.calls[0][0]),
            ).not.toContain("musicSourceRecording");
        },
    );
    it.each(["vk", "yandex"] as const)(
        "delivers %s public playback metadata in the ranked radio DTO",
        (provider) => {
            const track = native(provider),
                dto = toRadioContinuationTrack(track) as unknown as Record<
                    string,
                    unknown
                >;
            expect(dto.musicSourceRecording).toEqual(
                (track as unknown as Record<string, unknown>)
                    .musicSourceRecording,
            );
            expect(dto.streamSource).toBe(provider);
            expect(dto).not.toHaveProperty("canonicalRecordingId");
            expect(dto).not.toHaveProperty("candidateSources");
            expect(dto).not.toHaveProperty("youtubeVideoId");
        },
    );
    it.each(["vk", "yandex"] as const)(
        "batch reads a confirmed exact %s namespace without weak metadata matching",
        async (provider) => {
            const track = native(provider),
                recording = (
                    track as unknown as { musicSourceRecording: unknown }
                ).musicSourceRecording;
            mockMappingRows.mockResolvedValue([
                {
                    track: null,
                    trackYtMusic: null,
                    trackTidal: null,
                    trackMusicSource: {
                        provider,
                        providerTrackId:
                            provider === "vk" ? "-001_002" : "0007",
                        verifiedMetadata: recording,
                        metadataObservedAt: NOW,
                        metadataConnectionVersion: 7,
                    },
                    canonicalRecording: {
                        id: "canonical",
                        canonicalKey: "provider-known",
                        mergedIntoId: null,
                        identitySource: "verified-source",
                    },
                },
            ]);
            await expect(
                findMappedCanonicalCandidates([track]),
            ).resolves.toEqual([
                { id: "canonical", canonicalKey: "provider-known" },
            ]);
            expect(mockMappingRows).toHaveBeenCalledTimes(1);
            expect(mockMappingRows.mock.calls[0][0].where.OR).toEqual([
                expect.objectContaining({
                    trackMusicSource: expect.any(Object),
                }),
            ]);
        },
    );
    it.each(["vk", "yandex"] as const)(
        "never creates a weak %s canonical from unconfirmed upstream metadata",
        async (provider) => {
            const deps = {
                findProviderMapping: jest.fn().mockResolvedValue(null),
                findCanonical: jest.fn().mockResolvedValue(null),
                upsertCanonical: jest.fn().mockResolvedValue({
                    id: "wrong",
                    canonicalKey: "isrc:FAKE",
                }),
                attachProviderMapping: jest.fn().mockResolvedValue(undefined),
            };
            await expect(
                new CanonicalIdentityResolver(deps).resolve(native(provider)),
            ).rejects.toThrow();
            expect(deps.findCanonical).not.toHaveBeenCalled();
            expect(deps.upsertCanonical).not.toHaveBeenCalled();
            expect(deps.attachProviderMapping).not.toHaveBeenCalled();
        },
    );
});
