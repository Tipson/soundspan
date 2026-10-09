const mockCanonical = jest.fn(),
    mockDown = jest.fn(),
    mockNamespace = jest.fn(),
    mockMapping = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        canonicalRecording: {
            findMany: (...args: unknown[]) => mockCanonical(...args),
        },
        dislikedEntity: { findMany: (...args: unknown[]) => mockDown(...args) },
        trackMusicSource: {
            findMany: (...args: unknown[]) => mockNamespace(...args),
        },
        trackMapping: {
            findMany: (...args: unknown[]) => mockMapping(...args),
        },
        play: { findMany: jest.fn(async () => []) },
        recommendationExposure: { groupBy: jest.fn(async () => []) },
    },
}));
jest.mock("../../youtubeMusic", () => ({ ytMusicService: {} }));
import { loadSavedMoodCandidates } from "../featureStore";
const now = new Date("2026-10-08T10:00:00Z");
function row(i: number) {
    const recording = {
        provider: "vk",
        id: `-01_${i}`,
        title: `Song ${i}`,
        artists: [`Band ${i}`, "Guest"],
        duration: 180,
        preview: false,
        contentVersion: "unknown",
    };
    return {
        id: `canonical-${i}`,
        canonicalKey: `strong-${i}`,
        analysisStatus: "completed",
        mergedIntoId: null,
        identitySource: "provider-direct",
        arousal: 0.1,
        energy: 0.2,
        bpm: 80,
        valence: 0.5,
        danceability: 0.2,
        instrumentalness: 0.8,
        mappings: [
            {
                trackMusicSource: {
                    provider: "vk",
                    providerTrackId: recording.id,
                    verifiedMetadata: recording,
                    metadataObservedAt: now,
                    metadataConnectionVersion: 1,
                },
            },
        ],
    };
}
beforeEach(() => {
    jest.clearAllMocks();
    mockDown.mockResolvedValue([]);
    mockNamespace.mockResolvedValue([]);
    mockMapping.mockResolvedValue([]);
});
it("fills48 measured native saved candidates after exact downs, viewed and mood admission before capacity", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i + 100));
    mockCanonical.mockImplementation(async ({ where, cursor }) =>
        where.mappings.some.trackMusicSource && !cursor ? rows : [],
    );
    mockDown.mockImplementation(async ({ where }) =>
        where.entityId?.in
            ? rows.slice(0, 52).map((r) => ({
                  entityId: `vk:${r.mappings[0].trackMusicSource.providerTrackId}`,
              }))
            : [],
    );
    mockMapping.mockImplementation(async ({ where }) =>
        rows
            .filter((row) =>
                (where.OR ?? []).some(
                    (ref: any) =>
                        ref.trackMusicSource?.is?.provider === "vk" &&
                        ref.trackMusicSource.is.providerTrackId.in.includes(
                            row.mappings[0].trackMusicSource.providerTrackId,
                        ),
                ),
            )
            .map((row) => ({
                trackMusicSource: row.mappings[0].trackMusicSource,
                canonicalRecording: {
                    id: row.id,
                    canonicalKey: row.canonicalKey,
                    mergedIntoId: null,
                    identitySource: "provider-direct",
                },
            })),
    );
    // Mapping port reads actual strict namespaces; each namespace already names its live canonical survivor.
    mockNamespace.mockImplementation(async ({ where }) => {
        const refs = where.OR ?? [];
        return rows
            .filter((r) =>
                refs.some(
                    (ref: any) =>
                        ref.provider === "vk" &&
                        (
                            ref.providerTrackId?.in ?? [ref.providerTrackId]
                        ).includes(
                            r.mappings[0].trackMusicSource.providerTrackId,
                        ),
                ),
            )
            .map((r) => ({
                ...r.mappings[0].trackMusicSource,
                mappings: [
                    {
                        canonicalRecording: {
                            id: r.id,
                            canonicalKey: r.canonicalKey,
                            mergedIntoId: null,
                            identitySource: "provider-direct",
                        },
                    },
                ],
            }));
    });
    const result = await loadSavedMoodCandidates("owner", "calm", { now });
    expect(result).toHaveLength(48);
    expect(
        result.every(
            (t) =>
                t.source === "vk" &&
                Number(t.musicSourceRecording!.id.split("_")[1]) >= 152 &&
                t.audioFeatures?.arousal === 0.1,
        ),
    ).toBe(true);
    expect(
        mockCanonical.mock.calls.some(
            ([q]) =>
                q.where.mappings.some.trackMusicSource?.is?.likedTracks?.some
                    ?.userId === "owner",
        ),
    ).toBe(true);
});
it("never invents measured mood from an unverified namespace/private metadata", async () => {
    const bad = row(100);
    bad.mappings[0].trackMusicSource.metadataConnectionVersion = 0;
    mockCanonical.mockImplementation(async ({ where, cursor }) =>
        where.mappings.some.trackMusicSource && !cursor ? [bad] : [],
    );
    expect(await loadSavedMoodCandidates("owner", "calm", { now })).toEqual([]);
});
it("uses a confirmed owned mapping when a coarse eligible invalid mapping precedes it", async () => {
    const measured = row(500);
    const valid = measured.mappings[0].trackMusicSource;
    const invalid = {
        ...valid,
        providerTrackId: "-01_501",
        verifiedMetadata: {
            ...valid.verifiedMetadata,
            id: "-01_501",
            artists: [],
        },
    };
    measured.mappings.unshift({ trackMusicSource: invalid });
    mockCanonical.mockImplementation(async ({ where, cursor }) =>
        where.mappings.some.trackMusicSource && !cursor ? [measured] : [],
    );
    mockMapping.mockResolvedValue([
        {
            trackMusicSource: valid,
            canonicalRecording: {
                id: measured.id,
                canonicalKey: measured.canonicalKey,
                mergedIntoId: null,
                identitySource: "provider-direct",
            },
        },
    ]);
    const result = await loadSavedMoodCandidates("owner", "calm", { now });
    expect(result.map((candidate) => candidate.id)).toEqual(["vk:-01_500"]);
    expect(result[0].canonicalRecordingId).toBe(measured.id);
    expect(result[0].audioFeatures?.arousal).toBe(0.1);
});
