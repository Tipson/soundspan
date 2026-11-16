const mockDowns = jest.fn();
const mockLocal = jest.fn();
const mockYoutube = jest.fn();
const mockExposures = jest.fn();
const mockNamespaces = jest.fn();
const mockMappings = jest.fn();
const mockCanonicalMany = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        dislikedEntity: { findMany: mockDowns },
        track: { findMany: mockLocal },
        trackYtMusic: { findMany: mockYoutube },
        recommendationExposure: { findMany: mockExposures },
        trackMusicSource: { findMany: mockNamespaces },
        trackMapping: { findMany: mockMappings },
        canonicalRecording: { findMany: mockCanonicalMany },
    },
}));
// These tests use the real admission/identity/native policies, without starting providers.
jest.mock("../personalNativeCandidates", () => ({
    personalNativeCandidateService: {},
}));
jest.mock("@prisma/client", () => ({ Prisma: { AnyNull: "AnyNull" } }));
jest.mock("../../../utils/logger", () => {
    const log = {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        child: () => log,
    };
    return { logger: log };
});

import { finiteQueueAdmissionRequestSchema } from "../finiteQueueAdmissionContract";
import { readmitRecommendationQueue } from "../finiteQueueAdmission";

const now = new Date("2026-11-16T12:00:00Z");
const yt = "abcdefghijk",
    otherYt = "lmnopqrstuv",
    thirdYt = "0123456789_";
type Down = {
    id: string;
    userId: string;
    entityType: string;
    entityId: string;
    dislikedAt: Date;
};
const down = (entityId: string, userId = "alice", age = 1): Down => ({
    id: `${userId}-${entityId}`,
    userId,
    entityType: "track",
    entityId,
    dislikedAt: new Date(now.getTime() - age * 86_400_000),
});
const namespace = (
    id: string,
    provider: "vk" | "yandex" = "vk",
    artists = ["Artist"],
) => ({
    provider,
    providerTrackId: id,
    verifiedMetadata: {
        provider,
        id,
        title: `Song ${id}`,
        artists,
        duration: 180,
        contentVersion: "unknown",
        preview: false,
    },
    metadataObservedAt: now,
    metadataConnectionVersion: 1,
});
const canonical = {
    id: "master",
    canonicalKey: "isrc:USABC2400001",
    mergedIntoId: null,
    identitySource: "import-isrc",
    identityConfidence: 0.97,
    recordingMbid: null,
    isrc: "USABC2400001",
    title: "Same Song",
    artist: "Artist",
    duration: 180,
};
const verifiedMapping = () => ({
    stale: false,
    source: "manual",
    confidence: 1,
    trackYtMusic: {
        videoId: yt,
        title: "Same Song",
        artist: "Artist",
        duration: 180,
    },
    trackTidal: {
        tidalId: 42,
        title: "Same Song",
        artist: "Artist",
        duration: 180,
        isrc: "USABC2400001",
    },
    track: null,
    trackMusicSource: null,
    canonicalRecording: canonical,
});
let downs: Down[],
    youtube: Array<{
        videoId: string;
        artist: string;
        title: string;
        duration: number;
    }>,
    locals: Array<{
        id: string;
        origin: string;
        filePath: string | null;
        removedAt: Date | null;
        album: { location: string; artist: { name: string } };
        title: string;
        duration: number;
    }>,
    namespaces: ReturnType<typeof namespace>[],
    mappings: ReturnType<typeof verifiedMapping>[],
    exposures: Array<{
        userId: string;
        generationId: string;
        provider: string;
        providerTrackId: string;
        artistKey: string;
        generation: { userId: string; served: boolean };
    }>;

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    downs = [];
    youtube = [];
    locals = [];
    namespaces = [];
    mappings = [];
    exposures = [];
    mockDowns.mockImplementation(async ({ where, take, cursor, skip }: any) => {
        const selected = downs.filter(
            (r) =>
                r.userId === where.userId &&
                r.entityType === where.entityType &&
                (!where.entityId?.in ||
                    where.entityId.in.includes(r.entityId)) &&
                (!where.entityId?.startsWith ||
                    r.entityId.startsWith(where.entityId.startsWith)) &&
                (!where.dislikedAt?.gte ||
                    r.dislikedAt >= where.dislikedAt.gte) &&
                (!where.dislikedAt?.lte ||
                    r.dislikedAt <= where.dislikedAt.lte),
        );
        const offset = cursor
            ? selected.findIndex((r) => r.id === cursor.id) + skip
            : 0;
        return selected.slice(
            offset,
            take === undefined ? undefined : offset + take,
        );
    });
    mockYoutube.mockImplementation(async ({ where, take }: any) =>
        youtube
            .filter((r) => where.videoId.in.includes(r.videoId))
            .slice(0, take),
    );
    mockLocal.mockImplementation(async ({ where, take }: any) =>
        locals
            .filter(
                (r) =>
                    where.id.in.includes(r.id) &&
                    r.removedAt === null &&
                    ["LIBRARY", "DISCOVER", "REMOTE", "FEDERATED"].includes(
                        r.album.location,
                    ) &&
                    ["LOCAL", "FEDERATED"].includes(r.origin),
            )
            .slice(0, take),
    );
    mockNamespaces.mockImplementation(async ({ where, take }: any) =>
        namespaces
            .filter((r) =>
                where.OR.some(
                    (w: any) =>
                        w.provider === r.provider &&
                        w.providerTrackId.in.includes(r.providerTrackId),
                ),
            )
            .slice(0, take),
    );
    mockExposures.mockImplementation(async ({ where, take }: any) =>
        exposures
            .filter(
                (r) =>
                    r.userId === where.userId &&
                    r.provider === where.provider &&
                    r.generation.served === where.generation.served &&
                    r.generation.userId === where.generation.userId &&
                    where.OR.some(
                        (w: any) =>
                            w.generationId === r.generationId &&
                            w.providerTrackId === r.providerTrackId,
                    ),
            )
            .slice(0, take),
    );
    mockMappings.mockImplementation(async ({ where, take }: any) =>
        mappings
            .filter(
                (r) =>
                    !r.stale &&
                    (!where.source || where.source.in.includes(r.source)) &&
                    (where.canonicalRecordingId?.in
                        ? where.canonicalRecordingId.in.includes(
                              r.canonicalRecording.id,
                          )
                        : where.OR?.some(
                              (w: any) =>
                                  (w.trackYtMusic &&
                                      w.trackYtMusic.is.videoId.in.includes(
                                          r.trackYtMusic.videoId,
                                      )) ||
                                  (w.trackTidal &&
                                      w.trackTidal.is.tidalId.in.includes(
                                          r.trackTidal.tidalId,
                                      )),
                          )),
            )
            .slice(0, take),
    );
    mockCanonicalMany.mockImplementation(async ({ where, take }: any) =>
        [canonical]
            .filter((r) =>
                where.id?.in
                    ? where.id.in.includes(r.id)
                    : where.mergedIntoId?.in?.includes(r.mergedIntoId),
            )
            .slice(0, take),
    );
});
afterEach(() => jest.useRealTimers());

describe("finite queue admission input contract", () => {
    it("keeps provider namespaces, generation context and native leading zeroes", () => {
        const references = [
            { source: "library", id: "local_1-2" },
            { source: "youtube", id: yt, generationId: "gen-1" },
            { source: "tidal", id: "42" },
            { source: "vk", id: "-001_002" },
            { source: "yandex", id: "00042" },
        ];
        expect(finiteQueueAdmissionRequestSchema.parse({ references })).toEqual(
            { references },
        );
    });
    it.each([
        { references: [] },
        {
            references: Array.from({ length: 101 }, () => ({
                source: "youtube",
                id: yt,
            })),
        },
        { references: [{ source: "youtube", id: yt, artist: "forged" }] },
        { references: [{ source: "youtube", id: yt, canonicalKey: "forged" }] },
        { references: [{ source: "youtube", id: yt }], userId: "bob" },
        { references: [{ source: "youtube", id: "short" }] },
        { references: [{ source: "library", id: "../local" }] },
        { references: [{ source: "library", id: "a".repeat(129) }] },
        { references: [{ source: "tidal", id: "9007199254740992" }] },
        { references: [{ source: "tidal", id: "0" }] },
        { references: [{ source: "yandex", id: "000" }] },
        { references: [{ source: "vk", id: "12/42" }] },
        { references: [{ source: "youtube", id: yt, generationId: "" }] },
        {
            references: [
                { source: "youtube", id: yt, generationId: "a".repeat(129) },
            ],
        },
    ])(
        "rejects malformed, oversized or authoritative client fields: %j",
        (input) => {
            expect(
                finiteQueueAdmissionRequestSchema.safeParse(input).success,
            ).toBe(false);
        },
    );
});

describe("server-owned finite queue admission", () => {
    it("preserves order and duplicate occurrences without exposing metadata", async () => {
        downs = [down(`yt:${yt}`)];
        expect(
            await readmitRecommendationQueue("alice", [
                { source: "youtube", id: yt },
                { source: "library", id: "missing" },
                { source: "youtube", id: yt },
            ]),
        ).toEqual({
            version: 1,
            appliesTo: "recommended_future",
            decisions: [
                { source: "youtube", id: yt, state: "denied" },
                { source: "library", id: "missing", state: "allowed" },
                { source: "youtube", id: yt, state: "denied" },
            ],
        });
    });
    it("reads current exact negatives outside the bounded preference history and keeps owners separate", async () => {
        downs = [
            ...Array.from({ length: 2000 }, (_, i) => down(`old-${i}`)),
            down(`yt:${yt}`, "alice", 500),
            down("vk:-1_2", "bob"),
        ];
        const refs = [
            { source: "youtube" as const, id: yt },
            { source: "vk" as const, id: "-1_2" },
        ];
        expect(
            (await readmitRecommendationQueue("alice", refs)).decisions.map(
                (r) => r.state,
            ),
        ).toEqual(["denied", "allowed"]);
        expect(
            (await readmitRecommendationQueue("bob", refs)).decisions.map(
                (r) => r.state,
            ),
        ).toEqual(["allowed", "denied"]);
    });
    it("reuses verified cross-provider dislikes and observes clear without caching", async () => {
        mappings = [verifiedMapping()];
        downs = [down("tidal:42")];
        expect(
            (
                await readmitRecommendationQueue("alice", [
                    { source: "youtube", id: yt },
                ])
            ).decisions[0].state,
        ).toBe("denied");
        downs = [];
        expect(
            (
                await readmitRecommendationQueue("alice", [
                    { source: "youtube", id: yt },
                ])
            ).decisions[0].state,
        ).toBe("allowed");
    });
    it("does not promote a metadata-only mapping to a canonical negative", async () => {
        mappings = [
            {
                ...verifiedMapping(),
                source: "recommendation",
                confidence: 0.72,
            },
        ];
        downs = [down("tidal:42")];
        expect(
            (
                await readmitRecommendationQueue("alice", [
                    { source: "youtube", id: yt },
                ])
            ).decisions[0].state,
        ).toBe("allowed");
    });
    it("hydrates visible local and stored YouTube artists using the existing two-negative threshold", async () => {
        downs = [down(`yt:${yt}`)];
        youtube = [yt, otherYt, thirdYt].map((videoId) => ({
            videoId,
            artist: " Artist ",
            title: "Song",
            duration: 180,
        }));
        locals = [
            {
                id: "local",
                origin: "LOCAL",
                filePath: "/music/a.flac",
                removedAt: null,
                title: "Local",
                duration: 180,
                album: { location: "LIBRARY", artist: { name: "ARTIST" } },
            },
        ];
        const refs = [
            { source: "library" as const, id: "local" },
            { source: "youtube" as const, id: thirdYt },
        ];
        expect(
            (await readmitRecommendationQueue("alice", refs)).decisions.map(
                (r) => r.state,
            ),
        ).toEqual(["allowed", "allowed"]);
        downs.push(down(`yt:${otherYt}`));
        expect(
            (await readmitRecommendationQueue("alice", refs)).decisions.map(
                (r) => r.state,
            ),
        ).toEqual(["denied", "denied"]);
        locals[0].removedAt = now;
        expect(
            (await readmitRecommendationQueue("alice", refs)).decisions[0]
                .state,
        ).toBe("allowed");
        expect(mockLocal.mock.calls.at(-1)[0].where).toMatchObject({
            removedAt: null,
            AND: expect.any(Array),
        });
    });
    it("uses one owner-served exact exposure batch for cold YT, without promoting the generation to identity proof", async () => {
        downs = [down(`yt:${yt}`), down(`yt:${otherYt}`)];
        youtube = [yt, otherYt].map((videoId) => ({
            videoId,
            artist: "Artist",
            title: "Song",
            duration: 180,
        }));
        exposures = [
            {
                userId: "alice",
                generationId: "served",
                provider: "youtube",
                providerTrackId: thirdYt,
                artistKey: "artist",
                generation: { userId: "alice", served: true },
            },
            {
                userId: "alice",
                generationId: "unserved",
                provider: "youtube",
                providerTrackId: thirdYt,
                artistKey: "artist",
                generation: { userId: "alice", served: false },
            },
            {
                userId: "bob",
                generationId: "foreign",
                provider: "youtube",
                providerTrackId: thirdYt,
                artistKey: "artist",
                generation: { userId: "bob", served: true },
            },
        ];
        const result = await readmitRecommendationQueue("alice", [
            { source: "youtube", id: thirdYt, generationId: "served" },
            { source: "youtube", id: thirdYt, generationId: "unserved" },
            { source: "youtube", id: thirdYt, generationId: "foreign" },
            { source: "youtube", id: thirdYt },
            { source: "youtube", id: thirdYt, generationId: "served" },
        ]);
        expect(result.decisions.map((r) => r.state)).toEqual([
            "denied",
            "allowed",
            "allowed",
            "allowed",
            "denied",
        ]);
        expect(mockExposures).toHaveBeenCalledTimes(1);
        expect(mockExposures.mock.calls[0][0]).toMatchObject({
            where: {
                userId: "alice",
                provider: "youtube",
                generation: { served: true, userId: "alice" },
                OR: [
                    { generationId: "served", providerTrackId: thirdYt },
                    { generationId: "unserved", providerTrackId: thirdYt },
                    { generationId: "foreign", providerTrackId: thirdYt },
                ],
            },
            take: 3,
        });
    });
    it.each(["", "Unknown", "Unknown Artist"])(
        "falls back to the exact owner-served artist when stored artist is %j",
        async (artist) => {
            downs = [down(`yt:${yt}`), down(`yt:${otherYt}`)];
            youtube = [yt, otherYt].map((videoId) => ({
                videoId,
                artist: "Artist",
                title: "Song",
                duration: 180,
            }));
            youtube.push({
                videoId: thirdYt,
                artist,
                title: "Target",
                duration: 180,
            });
            exposures = [
                {
                    userId: "alice",
                    generationId: "g",
                    provider: "youtube",
                    providerTrackId: thirdYt,
                    artistKey: "artist",
                    generation: { userId: "alice", served: true },
                },
            ];
            const refs = [
                { source: "youtube" as const, id: thirdYt, generationId: "g" },
                { source: "youtube" as const, id: thirdYt },
            ];
            expect(
                (await readmitRecommendationQueue("alice", refs)).decisions.map(
                    (r) => r.state,
                ),
            ).toEqual(["denied", "allowed"]);
            youtube[2].artist = "Different artist";
            expect(
                (await readmitRecommendationQueue("alice", refs)).decisions.map(
                    (r) => r.state,
                ),
            ).toEqual(["allowed", "allowed"]);
        },
    );
    it("keeps unknown artist neutral and does not broaden the legacy normalization", async () => {
        downs = [down(`yt:${yt}`), down(`yt:${otherYt}`)];
        youtube = [yt, otherYt].map((videoId) => ({
            videoId,
            artist: "Ａrtist",
            title: "Song",
            duration: 180,
        }));
        exposures = [
            {
                userId: "alice",
                generationId: "g",
                provider: "youtube",
                providerTrackId: thirdYt,
                artistKey: "artist",
                generation: { userId: "alice", served: true },
            },
        ];
        expect(
            (
                await readmitRecommendationQueue("alice", [
                    { source: "youtube", id: thirdYt, generationId: "g" },
                    { source: "youtube", id: thirdYt },
                ])
            ).decisions.map((r) => r.state),
        ).toEqual(["allowed", "allowed"]);
    });
    it("suppresses only confirmed native credits within their provider namespace", async () => {
        downs = [down("vk:-1_1"), down("vk:-1_2")];
        namespaces = [
            namespace("-1_1"),
            namespace("-1_2"),
            namespace("-1_3"),
            namespace("003", "yandex"),
        ];
        expect(
            (
                await readmitRecommendationQueue("alice", [
                    { source: "vk", id: "-1_3" },
                    { source: "vk", id: "-1_4" },
                    { source: "yandex", id: "003" },
                    { source: "youtube", id: yt },
                ])
            ).decisions.map((r) => r.state),
        ).toEqual(["denied", "allowed", "allowed", "allowed"]);
    });
    it("keeps exact negatives denied across auxiliary proof and metadata failures", async () => {
        downs = [down(`yt:${yt}`), down("vk:-1_2")];
        mockMappings.mockRejectedValue(new Error("proof offline"));
        mockYoutube.mockRejectedValue(new Error("metadata offline"));
        mockNamespaces.mockRejectedValue(new Error("namespace offline"));
        expect(
            (
                await readmitRecommendationQueue("alice", [
                    { source: "youtube", id: yt },
                    { source: "vk", id: "-1_2" },
                    { source: "youtube", id: otherYt },
                ])
            ).decisions.map((r) => r.state),
        ).toEqual(["denied", "denied", "unavailable"]);
    });
    it("does not report allowed for unavailable current feedback", async () => {
        mockDowns.mockRejectedValue(new Error("preferences offline"));
        expect(
            (
                await readmitRecommendationQueue("alice", [
                    { source: "youtube", id: yt },
                    { source: "library", id: "local" },
                ])
            ).decisions.map((r) => r.state),
        ).toEqual(["unavailable", "unavailable"]);
    });
    it("confines failed YT suppression to rows with confirmed artists", async () => {
        youtube = [
            { videoId: yt, artist: "Artist", title: "Song", duration: 180 },
        ];
        const normal = mockDowns.getMockImplementation()!;
        mockDowns.mockImplementation(async (query) => {
            if (query.where.entityId?.startsWith === "yt:")
                throw new Error("suppression offline");
            return normal(query);
        });
        expect(
            (
                await readmitRecommendationQueue("alice", [
                    { source: "youtube", id: yt },
                    { source: "youtube", id: otherYt },
                    { source: "vk", id: "-1_2" },
                ])
            ).decisions.map((r) => r.state),
        ).toEqual(["unavailable", "allowed", "allowed"]);
    });
    it("confines failed cold exposure hydration to the requested generation contexts", async () => {
        mockExposures.mockRejectedValue(new Error("exposure offline"));
        expect(
            (
                await readmitRecommendationQueue("alice", [
                    { source: "youtube", id: yt, generationId: "g" },
                    { source: "youtube", id: yt },
                    { source: "library", id: "local" },
                ])
            ).decisions.map((r) => r.state),
        ).toEqual(["unavailable", "allowed", "allowed"]);
    });
    it("propagates cancellation before any I/O and after a held read", async () => {
        const stopped = new Error("cancelled");
        await expect(
            readmitRecommendationQueue(
                "alice",
                [{ source: "youtube", id: yt }],
                () => {
                    throw stopped;
                },
            ),
        ).rejects.toBe(stopped);
        expect(mockDowns).not.toHaveBeenCalled();
        let cancelled = false;
        mockYoutube.mockImplementation(async () => {
            cancelled = true;
            return [];
        });
        await expect(
            readmitRecommendationQueue(
                "alice",
                [{ source: "youtube", id: yt }],
                () => {
                    if (cancelled) throw stopped;
                },
            ),
        ).rejects.toBe(stopped);
    });
});
