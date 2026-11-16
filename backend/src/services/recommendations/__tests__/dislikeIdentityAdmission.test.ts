const mockDislikes = jest.fn();
const mockMappings = jest.fn();
const mockCanonical = jest.fn();
const mockCanonicalMany = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        dislikedEntity: { findMany: mockDislikes },
        trackMapping: { findMany: mockMappings },
        canonicalRecording: {
            findUnique: mockCanonical,
            findMany: mockCanonicalMany,
        },
    },
}));

import {
    filterCurrentDislikedCandidates,
    loadCurrentDislikeAdmission,
    loadDislikedTasteEmbeddings,
    type CurrentDislikeAdmission,
    recommendationFeatureStore,
} from "../featureStore";
import {
    findMappedCanonicalCandidates,
    readCanonicalCandidateEvidence,
    providerTrackIdentityToCandidate,
    buildCanonicalRecordingKey,
} from "../canonicalIdentity";
import { RecommendationEngine } from "../engine";
import { toNativeRecommendationCandidate } from "../nativeCandidates";
import type { RecommendationCandidate } from "../types";

interface CanonicalFixture {
    id: string;
    canonicalKey: string;
    mergedIntoId: string | null;
    identitySource: string;
    identityConfidence: number;
    recordingMbid: string | null;
    isrc: string | null;
    title: string;
    artist: string;
    duration: number;
}
const canonical = (id = "master"): CanonicalFixture => ({
    id,
    canonicalKey: `isrc:${id}`,
    mergedIntoId: null,
    identitySource: "import-isrc",
    identityConfidence: 0.97,
    recordingMbid: null,
    isrc: "USABC2400001",
    title: "Same Song",
    artist: "Artist",
    duration: 180,
});
const facts = (videoId: string) => ({
    videoId,
    title: "Same Song",
    artist: "Artist",
    duration: 180,
});
type MappingFixture = {
    stale: boolean;
    source: string;
    confidence: number;
    trackYtMusic: ReturnType<typeof facts> | null;
    trackTidal: {
        tidalId: number;
        title: string;
        artist: string;
        duration: number;
        isrc: string;
    } | null;
    track: {
        id: string;
        title: string;
        duration: number;
        isrc: string | null;
        recordingMbid: string | null;
        album: { artist: { name: string } };
    } | null;
    trackMusicSource: ReturnType<typeof nativeNamespace> | null;
    canonicalRecording: ReturnType<typeof canonical>;
};
const mapping = (videoId: string, verified = true): MappingFixture => ({
    stale: false,
    source: verified ? "manual" : "recommendation",
    confidence: verified ? 1 : 0.72,
    trackYtMusic: facts(videoId),
    trackTidal: {
        tidalId: 42,
        title: "Same Song",
        artist: "Artist",
        duration: 180,
        isrc: "USABC2400001",
    },
    track: null,
    trackMusicSource: null,
    canonicalRecording: canonical(),
});
const nativeRecording = () => ({
    provider: "vk" as const,
    id: "-1_2",
    title: "Same Song",
    artists: ["Artist"],
    duration: 180,
    contentVersion: "unknown" as const,
    preview: false as const,
    isrc: "USABC2400001",
});
const nativeMapping = (): MappingFixture => ({
    ...mapping("unused"),
    source: "verified-source",
    trackYtMusic: null,
    trackTidal: null,
    trackMusicSource: nativeNamespace(),
});
const nativeNamespace = () => ({
    provider: "vk",
    providerTrackId: "-1_2",
    verifiedMetadata: nativeRecording(),
    metadataObservedAt: new Date("2026-11-15T00:00:00Z"),
    metadataConnectionVersion: 2,
});
const track = (id: string) => ({
    ...providerTrackIdentityToCandidate({
        source: "youtube",
        providerTrackId: id,
        title: "Same Song",
        artist: "Artist",
        duration: 180,
    }),
    id: `yt:${id}`,
    ...overrides[id],
});
let dislikes: Record<string, string[]>;
let rows: ReturnType<typeof mapping>[];
let overrides: Record<string, Partial<RecommendationCandidate>>;
let extraCanonicals: ReturnType<typeof canonical>[];
const knownCanonicals = () =>
    new Map(
        [
            canonical(),
            ...rows.map((row) => row.canonicalRecording),
            ...extraCanonicals,
        ].map((row) => [row.id, row]),
    );
type MappingQuery = {
    where: {
        canonicalRecordingId?: { in?: string[]; not?: null };
        source?: { in: string[] };
        OR?: Array<{
            trackYtMusic?: { is: { videoId: { in: string[] } } };
            trackTidal?: { is: { tidalId: { in: number[] } } };
            track?: { is: { id: { in: string[] } } };
            trackMusicSource?: {
                is: { provider: string; providerTrackId: { in: string[] } };
            };
        }>;
    };
    take?: number;
};

beforeEach(() => {
    jest.clearAllMocks();
    dislikes = { alice: [] };
    rows = [];
    overrides = {};
    extraCanonicals = [];
    mockDislikes.mockImplementation(async ({ where, take }) =>
        (dislikes[where.userId] ?? [])
            .filter((id) =>
                where.entityId?.in
                    ? where.entityId.in.includes(id)
                    : where.entityId?.startsWith
                      ? id.startsWith(where.entityId.startsWith)
                      : !where.NOT ||
                        (!id.startsWith("vk:") && !id.startsWith("yandex:")),
            )
            .slice(0, take)
            .map((entityId) => ({ entityId })),
    );
    mockMappings.mockImplementation(async ({ where, take }: MappingQuery) =>
        rows
            .filter(
                (row) =>
                    !row.stale &&
                    (!where.source || where.source.in.includes(row.source)) &&
                    (where.canonicalRecordingId?.in
                        ? where.canonicalRecordingId.in.includes(
                              row.canonicalRecording.id,
                          )
                        : where.OR?.some((filter) => {
                              if (row.trackYtMusic && filter.trackYtMusic)
                                  return filter.trackYtMusic.is.videoId.in.includes(
                                      row.trackYtMusic.videoId,
                                  );
                              if (row.trackTidal && filter.trackTidal)
                                  return filter.trackTidal.is.tidalId.in.includes(
                                      row.trackTidal.tidalId,
                                  );
                              if (row.track && filter.track)
                                  return filter.track.is.id.in.includes(
                                      row.track.id,
                                  );
                              const native = row.trackMusicSource;
                              return (
                                  native &&
                                  filter.trackMusicSource?.is.provider ===
                                      native.provider &&
                                  filter.trackMusicSource.is.providerTrackId.in.includes(
                                      native.providerTrackId,
                                  )
                              );
                          })),
            )
            .slice(0, take ?? rows.length),
    );
    mockCanonical.mockImplementation(
        async ({ where }) => knownCanonicals().get(where.id) ?? null,
    );
    mockCanonicalMany.mockImplementation(async ({ where, take }) =>
        [...knownCanonicals().values()]
            .filter((row) =>
                where.id?.in
                    ? where.id.in.includes(row.id)
                    : where.mergedIntoId?.in
                      ? where.mergedIntoId.in.includes(row.mergedIntoId)
                      : false,
            )
            .slice(0, take),
    );
});

function group(
    prefix: string,
    count: number,
    ordinal: number,
): MappingFixture[] {
    const isrc = `USABC24${String(ordinal).padStart(5, "0")}`;
    return Array.from({ length: count }, (_, index) => ({
        ...mapping(`${prefix}-${index}`),
        trackTidal: {
            tidalId: 1000 + ordinal,
            title: "Same Song",
            artist: "Artist",
            duration: 180,
            isrc,
        },
        canonicalRecording: { ...canonical(prefix), isrc },
    }));
}

async function recommend(
    ids: string[],
    mode: "baseline" | "shadow" | "active" = "baseline",
    surface: "wave" | "made-for-you" | "similar-tracks" | "home" = "wave",
    userId = "alice",
) {
    let mappedSnapshot: Awaited<
        ReturnType<typeof findMappedCanonicalCandidates>
    > = [];
    let dislikedSnapshot: ReadonlySet<string> = new Set();
    let admissionSnapshot: CurrentDislikeAdmission | undefined;
    const supplied = ids.map((id) =>
        id === "vk:-1_2"
            ? toNativeRecommendationCandidate(
                  nativeRecording(),
                  "verified-fixture",
              )!
            : id.startsWith("tidal:")
              ? providerTrackIdentityToCandidate({
                    source: "tidal",
                    providerTrackId: id.slice(6),
                    title: "Same Song",
                    artist: "Artist",
                    duration: 180,
                })
              : track(id),
    );
    const engine = new RecommendationEngine({
        mode,
        hybridRolloutPercent: 100,
        explorationRate: 0,
        loadCandidates: async () => ({
            candidates: supplied,
            nextCursor: 1,
            degradedSources: [],
        }),
        loadCanonicalMappings: async (candidates) => {
            mappedSnapshot = await findMappedCanonicalCandidates(candidates);
            return mappedSnapshot;
        },
        resolveCanonical: async () => null,
        loadRecentExposures: async () => [],
        loadDislikedCanonicalKeys: async (owner, candidates) => {
            dislikedSnapshot =
                await recommendationFeatureStore.loadDislikedCanonicalKeys(
                    owner,
                    candidates,
                );
            return dislikedSnapshot;
        },
        loadDislikeAdmission: async (owner, candidates) => {
            const snapshot = await loadCurrentDislikeAdmission(
                owner,
                candidates,
            );
            admissionSnapshot = snapshot;
            dislikedSnapshot = snapshot.dislikedKeys;
            return snapshot;
        },
        loadTasteContext: async () => ({
            positiveCentroids: [],
            negativeCentroids: [],
        }),
        recordGeneration: async () => "fixture",
        scheduleHotSet: async () => {},
        now: () => new Date("2026-11-15T12:00:00Z"),
    });
    const generation = await engine.recommend({
        userId,
        sessionId: "fixture",
        limit: 20,
        intent: { surface, direction: "for-you" },
    });
    const result = generation.tracks.map((candidate) => candidate.id);
    // The external read-only baseline harness may retain actual admission observations.
    const trace = Reflect.get(globalThis, "__DEV09_IDENTITY_FIXTURE_TRACE__");
    const proof = (index: number) =>
        admissionSnapshot
            ? admissionSnapshot.verifiedCanonicalKeys.get(
                  `${supplied[index].source}:${supplied[index].id}`,
              )
            : mappedSnapshot[index]?.verifiedCanonicalKey;
    if (typeof trace === "function")
        trace({
            scenario: expect.getState().currentTestName,
            userId,
            mode,
            surface,
            requested: supplied.map((candidate) => candidate.id),
            admitted: result,
            degradedSources: generation.degradedSources,
            fixtureExact: supplied
                .filter((candidate) => {
                    const ownerRows = new Set(dislikes[userId] ?? []);
                    return [
                        candidate.id,
                        candidate.provider.youtubeVideoId ?? "",
                        candidate.provider.youtubeVideoId
                            ? `yt:${candidate.provider.youtubeVideoId}`
                            : "",
                        candidate.provider.tidalTrackId !== null
                            ? `tidal:${candidate.provider.tidalTrackId}`
                            : "",
                    ].some((ref) => ref && ownerRows.has(ref));
                })
                .map((candidate) => candidate.id),
            exact: supplied
                .filter((candidate) =>
                    [
                        candidate.id,
                        candidate.provider.youtubeVideoId ?? "",
                        candidate.provider.youtubeVideoId
                            ? `yt:${candidate.provider.youtubeVideoId}`
                            : "",
                        candidate.provider.tidalTrackId !== null
                            ? `tidal:${candidate.provider.tidalTrackId}`
                            : "",
                    ].some((key) => key && dislikedSnapshot.has(key)),
                )
                .map((candidate) => candidate.id),
            verified: supplied
                .filter(
                    (_, index) =>
                        proof(index) && dislikedSnapshot.has(proof(index)!),
                )
                .map((candidate) => candidate.id),
            unresolved: supplied
                .filter((_, index) => !proof(index))
                .map((candidate) => candidate.id),
            unavailable: supplied
                .filter(
                    (_, index) =>
                        admissionSnapshot?.unavailableCandidateReferences?.has(
                            `${supplied[index].source}:${supplied[index].id}`,
                        ) ||
                        (proof(index) &&
                            admissionSnapshot?.unavailableCanonicalKeys.has(
                                proof(index)!,
                            )),
                )
                .map((candidate) => candidate.id),
            coverage: admissionSnapshot?.diagnostics,
            unprovenCanonicalNegatives: supplied
                .filter(
                    (_, index) =>
                        mappedSnapshot[index] &&
                        !mappedSnapshot[index]?.verifiedCanonicalKey &&
                        dislikedSnapshot.has(
                            mappedSnapshot[index]!.canonicalKey,
                        ),
                )
                .map((candidate) => candidate.id),
        });
    return result;
}

async function observeLookup(
    requested: RecommendationCandidate[],
    keys: ReadonlySet<string>,
) {
    const trace = Reflect.get(globalThis, "__DEV09_IDENTITY_FIXTURE_TRACE__");
    if (typeof trace !== "function") return;
    const identities = await findMappedCanonicalCandidates(requested);
    trace({
        kind: "feedback-lookup",
        scenario: expect.getState().currentTestName,
        userId: "alice",
        requested: requested.map((candidate) => candidate.id),
        admitted: null,
        exact: requested
            .filter((candidate) => keys.has(candidate.id))
            .map((candidate) => candidate.id),
        verified: requested
            .filter(
                (_, index) =>
                    identities[index]?.verifiedCanonicalKey &&
                    keys.has(identities[index]!.verifiedCanonicalKey!),
            )
            .map((candidate) => candidate.id),
        unresolved: requested
            .filter((_, index) => !identities[index]?.verifiedCanonicalKey)
            .map((candidate) => candidate.id),
        unprovenCanonicalNegatives: requested
            .filter(
                (_, index) =>
                    identities[index] &&
                    !identities[index]?.verifiedCanonicalKey &&
                    keys.has(identities[index]!.canonicalKey),
            )
            .map((candidate) => candidate.id),
        unavailable: [],
        keys: [...keys],
    });
}

describe("owner dislikes require exact references or proven recording edges", () => {
    function denseTuples(references: number, tuples: number) {
        const candidates: RecommendationCandidate[] = [];
        rows = [];
        for (let index = 0; index < references; index += 1) {
            const videoId = `dense-${String(index).padStart(3, "0")}`;
            const isrc = `USABC24${String(index + 1).padStart(5, "0")}`;
            candidates.push(track(videoId));
            for (let slot = 0; slot < tuples; slot += 1) {
                const row = mapping(videoId);
                row.trackTidal!.tidalId = 100_000 + index * tuples + slot;
                row.trackTidal!.isrc = isrc;
                row.canonicalRecording = { ...canonical(videoId), isrc };
                rows.push(row);
            }
        }
        return candidates;
    }

    it.each([4, 5, 31, 32])(
        "proves 250 dense references with %i tuples in four strict reads",
        async (tuples) => {
            const candidates = denseTuples(250, tuples);
            const evidence = await readCanonicalCandidateEvidence(candidates);
            expect(evidence.unavailableCandidateIndexes.size).toBe(0);
            expect(
                evidence.recordings.map(
                    (identity) => identity?.verifiedCanonicalKey,
                ),
            ).toEqual(
                candidates.map(
                    (candidate) => `isrc:${candidate.provider.youtubeVideoId}`,
                ),
            );
            expect(mockMappings).toHaveBeenCalledTimes(4);
            for (const [query] of mockMappings.mock.calls) {
                const ids = query.where.OR.flatMap(
                    (filter: {
                        trackYtMusic?: { is: { videoId: { in: string[] } } };
                    }) => filter.trackYtMusic?.is.videoId.in ?? [],
                );
                expect(ids.length).toBeLessThanOrEqual(64);
                expect(query.take).toBe(ids.length * 32 + 1);
                expect(query.take).toBeLessThanOrEqual(2049);
            }
        },
    );

    it("keeps a complete pooled reference overflow local without splitting healthy peers", async () => {
        const candidates = denseTuples(64, 4);
        const crowded = rows.filter(
            (row) => row.trackYtMusic?.videoId === "dense-000",
        );
        for (let slot = 4; slot < 33; slot += 1) {
            const row = {
                ...crowded[0],
                trackTidal: {
                    ...crowded[0].trackTidal!,
                    tidalId: 900_000 + slot,
                },
            };
            rows.push(row);
        }
        const evidence = await readCanonicalCandidateEvidence(candidates);
        expect(evidence.unavailableCandidateIndexes).toEqual(new Set([0]));
        expect(evidence.recordings[0]).toBeNull();
        expect(
            evidence.recordings
                .slice(1)
                .every((identity) => identity?.verifiedCanonicalKey),
        ).toBe(true);
        expect(mockMappings).toHaveBeenCalledTimes(1);
    });

    it("splits only genuinely truncated strict chunks with a bounded retry tree", async () => {
        const candidates = denseTuples(64, 4);
        const crowded = rows.find(
            (row) => row.trackYtMusic?.videoId === "dense-000",
        )!;
        for (let slot = 4; slot < 2049; slot += 1)
            rows.unshift({
                ...crowded,
                trackTidal: { ...crowded.trackTidal!, tidalId: 900_000 + slot },
            });
        const evidence = await readCanonicalCandidateEvidence(candidates);
        expect(evidence.unavailableCandidateIndexes).toEqual(new Set([0]));
        expect(
            evidence.recordings
                .slice(1)
                .every((identity) => identity?.verifiedCanonicalKey),
        ).toBe(true);
        expect(mockMappings).toHaveBeenCalledTimes(13);
        expect(
            mockMappings.mock.calls.every(([query]) => query.take <= 2049),
        ).toBe(true);
    });

    it("deduplicates dense strict reads while preserving requested order and positions", async () => {
        const candidates = denseTuples(250, 4);
        const input = [...candidates].reverse().concat(candidates[0]);
        const evidence = await readCanonicalCandidateEvidence(input);
        expect(
            evidence.recordings.map(
                (identity) => identity?.verifiedCanonicalKey,
            ),
        ).toEqual(
            input.map(
                (candidate) => `isrc:${candidate.provider.youtubeVideoId}`,
            ),
        );
        expect(mockMappings).toHaveBeenCalledTimes(4);
        expect(evidence.unavailableCandidateIndexes.size).toBe(0);
    });

    it("cancels dense strict evidence before starting its next chunk", async () => {
        const candidates = denseTuples(250, 4);
        let stopped = false;
        const normal = mockMappings.getMockImplementation()!;
        mockMappings.mockImplementationOnce(async (query: MappingQuery) => {
            const result = await normal(query);
            stopped = true;
            return result;
        });
        await expect(
            readCanonicalCandidateEvidence(candidates, () => {
                if (stopped) throw new Error("dense forward cancelled");
            }),
        ).rejects.toThrow("dense forward cancelled");
        expect(mockMappings).toHaveBeenCalledTimes(1);
    });

    function forwardTuples(count: number) {
        dislikes.alice = ["yt:blocked"];
        const blocked = mapping("blocked");
        blocked.trackTidal!.tidalId = 900;
        rows = [
            blocked,
            ...Array.from({ length: count }, (_, index) => {
                const alias = mapping("alias");
                alias.trackTidal!.tidalId = 100 + index;
                return alias;
            }),
        ];
    }

    it.each([3, 4, 5, 32, 33])(
        "does not unban a proved alias at %i distinct forward tuples",
        async (count) => {
            forwardTuples(count);
            expect(await recommend(["alias"])).toEqual([]);
            const snapshot = await loadCurrentDislikeAdmission("alice", [
                track("alias"),
            ]);
            if (count <= 32) {
                expect(
                    snapshot.verifiedCanonicalKeys.get("youtube:yt:alias"),
                ).toBe("isrc:master");
            } else {
                expect(
                    snapshot.unavailableCandidateReferences?.has(
                        "youtube:yt:alias",
                    ),
                ).toBe(true);
                expect(snapshot.diagnostics.forwardUnavailableReferences).toBe(
                    1,
                );
            }
            expect(snapshot.dislikedKeys.has("youtube:yt:alias")).toBe(false);
        },
    );

    it("keeps a healthy reference available beside forward overflow independently of input order", async () => {
        forwardTuples(40);
        rows.push(...group("healthy", 1, 999));
        expect(await recommend(["alias", "healthy-0"])).toEqual([
            "yt:healthy-0",
        ]);
        expect(await recommend(["healthy-0", "alias"])).toEqual([
            "yt:healthy-0",
        ]);
        const snapshot = await loadCurrentDislikeAdmission("alice", [
            track("alias"),
            track("healthy-0"),
        ]);
        expect(snapshot.unavailableCandidateReferences).toEqual(
            new Set(["youtube:yt:alias"]),
        );
        expect(snapshot.verifiedCanonicalKeys.get("youtube:yt:healthy-0")).toBe(
            "isrc:healthy",
        );
    });

    it("keeps exact provider feedback at the forward evidence bound", async () => {
        forwardTuples(33);
        dislikes.alice = ["yt:alias"];
        expect(await recommend(["alias"])).toEqual([]);
    });

    it("keeps forward overflow ephemeral and owner scoped instead of creating a negative", async () => {
        forwardTuples(33);
        dislikes.alice = ["yt:unrelated"];
        const snapshot = await loadCurrentDislikeAdmission("alice", [
            track("alias"),
        ]);
        expect(snapshot.unavailableCandidateReferences).toEqual(
            new Set(["youtube:yt:alias"]),
        );
        expect(snapshot.dislikedKeys).toEqual(new Set(["yt:unrelated"]));
        expect(await recommend(["alias"])).toEqual([]);
        expect(await recommend(["alias"], "baseline", "wave", "bob")).toEqual([
            "yt:alias",
        ]);
    });

    it("keeps the soft resolver fallback while strict evidence reads recover complete tuples", async () => {
        forwardTuples(4);
        expect(await findMappedCanonicalCandidates([track("alias")])).toEqual([
            null,
        ]);
        const evidence = await readCanonicalCandidateEvidence([
            track("alias"),
            track("alias"),
        ]);
        expect(
            evidence.recordings.map(
                (identity) => identity?.verifiedCanonicalKey,
            ),
        ).toEqual(["isrc:master", "isrc:master"]);
        expect(evidence.unavailableCandidateIndexes.size).toBe(0);
    });

    it("cancels a split forward read before another DB query", async () => {
        forwardTuples(40);
        rows.push(...group("healthy", 1, 999));
        let stopped = false;
        const normal = mockMappings.getMockImplementation()!;
        mockMappings.mockImplementationOnce(async (query: MappingQuery) => {
            const result = await normal(query);
            stopped = true;
            return result;
        });
        await expect(
            readCanonicalCandidateEvidence(
                [track("alias"), track("healthy-0")],
                () => {
                    if (stopped) throw new Error("forward cancelled");
                },
            ),
        ).rejects.toThrow("forward cancelled");
        expect(mockMappings).toHaveBeenCalledTimes(1);
    });

    it("clears identity availability restrictions when this owner has no track dislikes", async () => {
        rows = group("crowded", 33, 1);
        dislikes.alice = ["yt:unrelated"];
        expect(await recommend(["crowded-0"])).toEqual([]);
        dislikes.alice = [];
        expect(await recommend(["crowded-0"])).toEqual(["yt:crowded-0"]);
        forwardTuples(33);
        dislikes.alice = [];
        expect(await recommend(["alias"])).toEqual(["yt:alias"]);
    });

    it.each(["wave", "made-for-you", "similar-tracks", "home"] as const)(
        "keeps an unmapped exact provider dislike out of baseline %s",
        async (surface) => {
            dislikes.alice = ["yt:blocked"];
            expect(
                await recommend(["blocked", "fresh"], "baseline", surface),
            ).toEqual(["yt:fresh"]);
            expect(
                await recommend(["blocked"], "baseline", surface, "bob"),
            ).toEqual(["yt:blocked"]);
        },
    );

    it("does not promote metadata-only mapping into a canonical dislike", async () => {
        dislikes.alice = ["yt:blocked"];
        rows = [mapping("blocked", false)];
        const keys =
            await recommendationFeatureStore.loadDislikedCanonicalKeys("alice");
        await observeLookup([track("blocked")], keys);
        expect(keys).toEqual(new Set(["yt:blocked"]));
    });

    it("does not promote manual provider linkage whose canonical attachment is metadata-only", async () => {
        dislikes.alice = ["yt:blocked"];
        rows = [mapping("blocked"), mapping("other")];
        for (const row of rows)
            row.canonicalRecording.identitySource = "metadata";
        const keys =
            await recommendationFeatureStore.loadDislikedCanonicalKeys("alice");
        await observeLookup([track("blocked")], keys);
        expect(keys).toEqual(new Set(["yt:blocked"]));
        expect(await recommend(["other"])).toEqual(["yt:other"]);
    });

    it.each(["baseline", "shadow", "active"] as const)(
        "blocks a verified alias but keeps an unverified same-canonical candidate in %s",
        async (mode) => {
            dislikes.alice = ["yt:blocked"];
            rows = [
                mapping("blocked"),
                mapping("verified"),
                mapping("unverified", false),
            ];
            expect(await recommend(["verified", "unverified"], mode)).toEqual([
                "yt:unverified",
            ]);
        },
    );

    it("follows a preserved merge alias and removes the signal after clear", async () => {
        dislikes.alice = ["yt:blocked"];
        const alias = mapping("blocked");
        alias.canonicalRecording = canonical("old");
        rows = [alias];
        const before = await findMappedCanonicalCandidates([track("blocked")]);
        expect(before[0]?.canonicalKey).toBe("isrc:old");
        alias.canonicalRecording = {
            ...canonical("old"),
            mergedIntoId: "master",
            identitySource: "identity-merged",
        };
        rows = [alias, mapping("other")];
        const after = await findMappedCanonicalCandidates([track("blocked")]);
        expect(after[0]?.canonicalKey).toBe("isrc:master");
        expect(
            await recommendationFeatureStore.loadDislikedCanonicalKeys("alice"),
        ).toEqual(new Set(["yt:blocked", "isrc:master"]));
        expect(await recommend(["other"])).toEqual([]);
        dislikes.alice = [];
        expect(await recommend(["other"])).toEqual(["yt:other"]);
    });

    it("does not lose the exact ban when evidence becomes stale", async () => {
        dislikes.alice = ["yt:blocked"];
        rows = [{ ...mapping("blocked"), stale: true }, mapping("other")];
        expect(await recommend(["blocked", "other"])).toEqual(["yt:other"]);
    });

    it.each([
        ["live", { title: "Same Song (Live)" }],
        ["remaster", { title: "Same Song (2020 Remaster)" }],
        ["cover", { title: "Same Song (Cover)" }],
        ["homonym", { artist: "Another Artist" }],
        ["duration", { duration: 240 }],
        ["duration boundary", { duration: 193 }],
    ])(
        "keeps the incompatible %s recording despite a shared stored canonical",
        async (_reason, changes) => {
            dislikes.alice = ["yt:blocked"];
            const control = mapping("control");
            Object.assign(control.trackYtMusic!, changes);
            rows = [mapping("blocked"), control];
            expect(await recommend(["control"])).toEqual(["yt:control"]);
        },
    );

    it("blocks the same verified recording across providers in both directions", async () => {
        rows = [nativeMapping(), mapping("youtube-alias")];
        dislikes.alice = ["vk:-1_2"];
        expect(await recommend(["youtube-alias"])).toEqual([]);
        dislikes.alice = ["yt:youtube-alias"];
        expect(await recommend(["vk:-1_2"])).toEqual([]);
        expect(await recommend(["vk:-1_2"], "baseline", "wave", "bob")).toEqual(
            ["vk:-1_2"],
        );
    });

    it("does not trust a shared ISRC when the server-confirmed version differs", async () => {
        const version = nativeMapping();
        version.trackMusicSource!.verifiedMetadata.title = "Same Song (Live)";
        rows = [version, mapping("youtube-alias")];
        dislikes.alice = ["vk:-1_2"];
        expect(await recommend(["youtube-alias"])).toEqual([
            "yt:youtube-alias",
        ]);
    });

    it("never treats promoted metadata edges or forged candidate fields as proof", async () => {
        dislikes.alice = ["yt:blocked"];
        rows = [mapping("blocked"), mapping("unverified", false)];
        rows[1].canonicalRecording.identitySource = "acoustid";
        overrides.unverified = {
            canonicalKey: "isrc:master",
            canonicalRecordingId: "master",
            isrc: "USABC2400001",
            recordingMbid: "forged",
            fingerprint: "forged",
        };
        expect(await recommend(["unverified"])).toEqual(["yt:unverified"]);
    });

    it("does not borrow a remote tuple's proof for a metadata-added local edge", async () => {
        dislikes.alice = ["local"];
        const row = mapping("alias");
        row.track = {
            id: "local",
            title: "Same Song",
            duration: 180,
            isrc: null,
            recordingMbid: null,
            album: { artist: { name: "Artist" } },
        };
        rows = [row];
        expect(await recommend(["alias"])).toEqual(["yt:alias"]);
        const local = providerTrackIdentityToCandidate({
            source: "library",
            providerTrackId: "local",
            title: "Same Song",
            artist: "Artist",
            duration: 180,
        });
        expect(
            (await findMappedCanonicalCandidates([local]))[0]
                ?.verifiedCanonicalKey,
        ).toBeUndefined();
        expect(await filterCurrentDislikedCandidates("alice", [local])).toEqual(
            [],
        );
    });

    it("rejects a contradictory durable counterpart instead of choosing a matching metadata peer", async () => {
        dislikes.alice = ["yt:blocked"];
        const row = mapping("alias");
        row.trackTidal!.isrc = "GBABC2400002";
        row.track = {
            id: "local",
            title: "Same Song",
            duration: 180,
            isrc: "USABC2400001",
            recordingMbid: null,
            album: { artist: { name: "Artist" } },
        };
        rows = [mapping("blocked"), row];
        expect(await recommend(["alias"])).toEqual(["yt:alias"]);
    });

    it("uses valid case-normalized MBID facts and downgrades changed or invalid local tags", async () => {
        const mbid = "51a5c1d4-15b3-4a90-9d36-123456789abc";
        const local = {
            id: "local",
            title: "Same Song",
            duration: 180,
            isrc: null,
            recordingMbid: mbid.toUpperCase(),
            album: { artist: { name: "Artist" } },
        };
        rows = [mapping("blocked"), mapping("alias")];
        for (const row of rows) {
            row.trackTidal = null;
            row.track = local;
            row.canonicalRecording = {
                ...canonical(),
                canonicalKey: `mbid:${mbid}`,
                recordingMbid: mbid,
                isrc: null,
                identitySource: "acoustid",
            };
        }
        dislikes.alice = ["local"];
        expect(await recommend(["alias"])).toEqual([]);
        local.recordingMbid = "51a5c1d4-15b3-4a90-9d36-123456789abd";
        expect(await recommend(["alias"])).toEqual(["yt:alias"]);
        local.recordingMbid = "not-a-mbid";
        for (const row of rows)
            row.canonicalRecording.recordingMbid = "not-a-mbid";
        expect(await recommend(["alias"])).toEqual(["yt:alias"]);
    });

    it("accepts an explicit server ISRC pair but rejects incompatible versions and weak confidence", async () => {
        const pair = mapping("youtube-alias");
        pair.source = "isrc";
        pair.confidence = 0.95;
        pair.trackTidal = {
            tidalId: 42,
            title: "Same Song",
            artist: "Artist",
            duration: 180,
            isrc: "USABC2400001",
        };
        rows = [pair];
        dislikes.alice = ["tidal:42"];
        expect(await recommend(["youtube-alias"])).toEqual([]);
        dislikes.alice = ["yt:youtube-alias"];
        expect(await recommend(["tidal:42"])).toEqual([]);
        pair.trackYtMusic!.title = "Same Song (Remix)";
        dislikes.alice = ["tidal:42"];
        expect(await recommend(["youtube-alias"])).toEqual([
            "yt:youtube-alias",
        ]);
        pair.trackYtMusic!.title = "Same Song";
        pair.confidence = 0.1;
        expect(await recommend(["youtube-alias"])).toEqual([
            "yt:youtube-alias",
        ]);
    });

    it("keeps exact native feedback without mapping", async () => {
        dislikes.alice = ["vk:-1_2"];
        expect(await recommend(["vk:-1_2"])).toEqual([]);
    });

    it("readmits saved candidates with current exact/verified feedback and cancellation", async () => {
        dislikes.alice = ["yt:blocked"];
        rows = [
            mapping("blocked"),
            mapping("alias"),
            mapping("unproven", false),
        ];
        const input = [
            track("fresh"),
            track("alias"),
            track("unproven"),
            track("blocked"),
        ];
        expect(
            (await filterCurrentDislikedCandidates("alice", input)).map(
                (candidate) => candidate.id,
            ),
        ).toEqual(["yt:fresh", "yt:unproven"]);
        expect(await filterCurrentDislikedCandidates("bob", input)).toEqual(
            input,
        );
        const check = jest.fn(() => {
            throw new Error("request cancelled");
        });
        mockDislikes.mockClear();
        await expect(
            filterCurrentDislikedCandidates("alice", input, check),
        ).rejects.toThrow("request cancelled");
        expect(mockDislikes).not.toHaveBeenCalled();
        let cancelled = false;
        mockDislikes.mockImplementationOnce(async () => {
            cancelled = true;
            return [];
        });
        await expect(
            filterCurrentDislikedCandidates("alice", input, () => {
                if (cancelled) throw new Error("cancelled during owner read");
            }),
        ).rejects.toThrow("cancelled during owner read");
        mockDislikes.mockClear();
        expect(await filterCurrentDislikedCandidates("alice", [])).toEqual([]);
        expect(mockDislikes).not.toHaveBeenCalled();
    });

    it("resolves duplicate old aliases to one survivor and preserves metadata dedupe", async () => {
        const old = mapping("blocked");
        old.canonicalRecording = {
            ...canonical("old"),
            mergedIntoId: "master",
            identitySource: "identity-merged",
        };
        rows = [old, mapping("blocked")];
        expect(await findMappedCanonicalCandidates([track("blocked")])).toEqual(
            [
                {
                    id: "master",
                    canonicalKey: "isrc:master",
                    verifiedCanonicalKey: "isrc:master",
                },
            ],
        );
        expect(buildCanonicalRecordingKey(track("unmapped"))).toBe(
            "meta:artist:same song:180",
        );
        rows = [mapping("unmapped", false)];
        rows[0].canonicalRecording = {
            ...canonical(),
            canonicalKey: "meta:artist:same song:180",
            identitySource: "metadata",
        };
        expect(
            await findMappedCanonicalCandidates([track("unmapped")]),
        ).toEqual([
            { id: "master", canonicalKey: "meta:artist:same song:180" },
        ]);
    });

    it("keeps exact feedback if optional mapping evidence fails", async () => {
        dislikes.alice = ["yt:blocked"];
        const normal = mockMappings.getMockImplementation()!;
        mockMappings.mockImplementation(async (query: MappingQuery) => {
            const ids =
                query.where.OR?.flatMap(
                    (filter) => filter.trackYtMusic?.is.videoId.in ?? [],
                ) ?? [];
            if (ids.length === 1 && ids[0] === "blocked")
                throw new Error("profile alias evidence unavailable");
            return normal(query);
        });
        expect(await recommend(["blocked", "fresh"])).toEqual(["yt:fresh"]);
        const snapshot = await loadCurrentDislikeAdmission("alice", [
            track("blocked"),
            track("fresh"),
        ]);
        expect(snapshot.dislikedKeys.has("yt:blocked")).toBe(true);
        expect(snapshot.diagnostics.aliasLookupFailures).toBeGreaterThan(0);
    });

    it("does not silently turn a failed current-pool proof read into a neutral miss", async () => {
        dislikes.alice = ["yt:blocked"];
        mockMappings.mockRejectedValue(
            new Error("forward evidence unavailable"),
        );
        expect(await recommend(["blocked", "fresh"])).toEqual([]);
        const snapshot = await loadCurrentDislikeAdmission("alice", [
            track("blocked"),
            track("fresh"),
        ]);
        expect(snapshot.dislikedKeys).toEqual(new Set(["yt:blocked"]));
        expect(snapshot.unavailableCandidateReferences).toEqual(
            new Set(["youtube:yt:blocked", "youtube:yt:fresh"]),
        );
        expect(snapshot.diagnostics.forwardUnavailableReferences).toBe(2);
        expect(snapshot.diagnostics.aliasLookupFailures).toBeGreaterThan(0);
    });

    it("bounds forward outage reads while explicitly marking every unread reference", async () => {
        const input = Array.from({ length: 501 }, (_, index) =>
            track(`candidate-${index}`),
        );
        mockMappings.mockRejectedValue(
            new Error("forward evidence unavailable"),
        );
        const evidence = await readCanonicalCandidateEvidence(input);
        expect(mockMappings).toHaveBeenCalledTimes(1);
        expect(mockMappings.mock.calls[0][0].take).toBe(2049);
        expect(evidence.lookupFailures).toBe(1);
        expect(evidence.recordings.every((identity) => identity === null)).toBe(
            true,
        );
        expect(evidence.unavailableCandidateIndexes.size).toBe(input.length);
    });

    it("does not serve a typed generation when current owner feedback is unavailable", async () => {
        dislikes.alice = ["yt:blocked"];
        mockDislikes.mockRejectedValue(new Error("owner feedback unavailable"));
        expect(await recommend(["blocked", "fresh"])).toEqual([]);
    });

    it("checks exact current-pool feedback older than the 2000-row profile window", async () => {
        dislikes.alice = [
            ...Array.from({ length: 2000 }, (_, index) => `yt:recent-${index}`),
            "yt:old",
        ];
        expect(await recommend(["old", "fresh"])).toEqual(["yt:fresh"]);
        expect(
            mockDislikes.mock.calls.some(([query]) =>
                query.where.entityId?.in?.includes("yt:old"),
            ),
        ).toBe(true);
    });

    it("keeps a verified alias dislike older than the 2000-row profile window", async () => {
        dislikes.alice = [
            ...Array.from({ length: 2000 }, (_, index) => `yt:recent-${index}`),
            "yt:old",
        ];
        rows = [mapping("old"), mapping("alias")];
        expect(await recommend(["alias"])).toEqual([]);
        const old = rows[0];
        old.canonicalRecording = {
            ...canonical("old"),
            mergedIntoId: "master",
            identitySource: "identity-merged",
        };
        expect(await recommend(["alias"])).toEqual([]);
        dislikes.alice = dislikes.alice.filter((id) => id !== "yt:old");
        expect(await recommend(["alias"])).toEqual(["yt:alias"]);
    });

    it("admits complete family/mapping bounds while enforcing an old verified dislike", async () => {
        dislikes.alice = [
            ...Array.from({ length: 2000 }, (_, index) => `yt:recent-${index}`),
            "yt:within-31",
        ];
        rows = group("within", 32, 1);
        extraCanonicals = Array.from({ length: 15 }, (_, index) => ({
            ...canonical(`old${index}`),
            mergedIntoId: "within",
            identitySource: "identity-merged",
        }));
        expect(await recommend(["within-0"])).toEqual([]);
        const snapshot = await loadCurrentDislikeAdmission("alice", [
            track("within-0"),
        ]);
        expect(snapshot.unavailableCanonicalKeys.size).toBe(0);
        expect(snapshot.dislikedKeys.has("isrc:within")).toBe(true);
    });

    it("does not turn an ambiguous inverse provider edge into a canonical dislike", async () => {
        dislikes.alice = [
            ...Array.from({ length: 2000 }, (_, index) => `yt:recent-${index}`),
            "yt:old",
        ];
        const conflicting = group("outside", 1, 99)[0];
        conflicting.trackYtMusic = facts("old");
        rows = [mapping("old"), mapping("alias"), conflicting];
        expect(await recommend(["alias"])).toEqual(["yt:alias"]);
        const snapshot = await loadCurrentDislikeAdmission("alice", [
            track("alias"),
        ]);
        expect(snapshot.dislikedKeys.has("isrc:master")).toBe(false);
        expect(snapshot.diagnostics.unresolvedReferences).toBeGreaterThan(0);
        expect(await recommend(["alias"])).toEqual(["yt:alias"]);
    });

    it("keeps uncertainty local to owned aliases when a global proof batch is truncated", async () => {
        dislikes.alice = [
            ...Array.from({ length: 2000 }, (_, index) => `yt:recent-${index}`),
            "yt:old",
        ];
        rows = [
            mapping("old"),
            mapping("alias"),
            ...Array.from({ length: 24 }, (_, index) => {
                const weak = group(`weak${index}`, 1, index + 100)[0];
                weak.source = "recommendation";
                weak.confidence = 0.72;
                weak.trackYtMusic = facts("old");
                return weak;
            }),
            ...group("healthy", 1, 999),
        ];
        const input = [track("alias"), track("healthy-0")];
        expect(await recommend(["alias", "healthy-0"])).toEqual([
            "yt:healthy-0",
        ]);
        const snapshot = await loadCurrentDislikeAdmission("alice", input);
        expect(snapshot.unavailableCanonicalKeys).toEqual(
            new Set(["isrc:master"]),
        );
        expect(snapshot.dislikedKeys.has("isrc:master")).toBe(false);
    });

    it("marks only an overflowing canonical group unavailable and keeps native exact/healthy candidates", async () => {
        dislikes.alice = ["yt:unrelated"];
        const native = nativeMapping();
        native.canonicalRecording = {
            ...canonical("native"),
            canonicalKey: "provider:vk:-1_2",
            identitySource: "verified-source",
        };
        rows = [...group("crowded", 33, 1), ...group("healthy", 1, 2), native];
        const input = [
            track("crowded-0"),
            toNativeRecommendationCandidate(nativeRecording(), "coverage")!,
            track("healthy-0"),
        ];
        expect(await recommend(["crowded-0", "vk:-1_2", "healthy-0"])).toEqual([
            "vk:-1_2",
            "yt:healthy-0",
        ]);
        const snapshot = await loadCurrentDislikeAdmission("alice", input);
        expect(snapshot.unavailableCanonicalKeys).toEqual(
            new Set(["isrc:crowded"]),
        );
        expect(snapshot.dislikedKeys.has("isrc:crowded")).toBe(false);
        expect(
            (await filterCurrentDislikedCandidates("alice", input)).map(
                (candidate) => candidate.id,
            ),
        ).toEqual(["vk:-1_2", "yt:healthy-0"]);
        expect(await loadDislikedTasteEmbeddings("alice")).toEqual([]);
        expect(
            mockCanonicalMany.mock.calls.some(([query]) =>
                query.where.canonicalKey?.in?.includes("isrc:crowded"),
            ),
        ).toBe(false);
    });

    it("applies the total alias budget independently of input order without poisoning healthy groups", async () => {
        dislikes.alice = ["yt:unrelated"];
        rows = [
            ...Array.from({ length: 65 }, (_, index) =>
                group(`g${index}`, 32, index + 1),
            ).flat(),
            ...group("healthy", 1, 100),
        ];
        const input = [
            ...Array.from({ length: 65 }, (_, index) => track(`g${index}-0`)),
            track("healthy-0"),
        ];
        expect(
            await recommend([
                ...Array.from({ length: 65 }, (_, index) => `g${index}-0`),
                "healthy-0",
            ]),
        ).toEqual(["yt:healthy-0"]);
        const first = await loadCurrentDislikeAdmission("alice", input);
        const reversed = await loadCurrentDislikeAdmission(
            "alice",
            [...input].reverse(),
        );
        expect(first.unavailableCanonicalKeys.size).toBe(65);
        expect(reversed.unavailableCanonicalKeys).toEqual(
            first.unavailableCanonicalKeys,
        );
        expect(first.unavailableCanonicalKeys.has("isrc:healthy")).toBe(false);
        expect(first.diagnostics.verifiedAliasReferences).toBeLessThanOrEqual(
            2048,
        );
        expect(
            [...first.dislikedKeys].some((key) =>
                first.unavailableCanonicalKeys.has(key),
            ),
        ).toBe(false);
    });

    it("bounds preserved merge ancestors locally and cancels inverse reads", async () => {
        dislikes.alice = ["yt:unrelated"];
        rows = [...group("crowded", 1, 1), ...group("healthy", 1, 2)];
        extraCanonicals = Array.from({ length: 17 }, (_, index) => ({
            ...canonical(`old${index}`),
            mergedIntoId: "crowded",
            identitySource: "identity-merged",
        }));
        const input = [track("crowded-0"), track("healthy-0")];
        expect(await recommend(["crowded-0", "healthy-0"])).toEqual([
            "yt:healthy-0",
        ]);
        const snapshot = await loadCurrentDislikeAdmission("alice", input);
        expect(snapshot.unavailableCanonicalKeys).toEqual(
            new Set(["isrc:crowded"]),
        );
        let cancelled = false;
        mockCanonicalMany.mockImplementationOnce(async () => {
            cancelled = true;
            return [];
        });
        await expect(
            loadCurrentDislikeAdmission("alice", input, () => {
                if (cancelled) throw new Error("inverse cancelled");
            }),
        ).rejects.toThrow("inverse cancelled");
    });

    it("does no dislike I/O for an explicit empty pool and bounds large exact queries", async () => {
        expect(
            await recommendationFeatureStore.loadDislikedCanonicalKeys(
                "alice",
                [],
            ),
        ).toEqual(new Set());
        expect(mockDislikes).not.toHaveBeenCalled();
        const candidates = Array.from({ length: 501 }, (_, index) =>
            track(String(index)),
        );
        await recommendationFeatureStore.loadDislikedCanonicalKeys(
            "alice",
            candidates,
        );
        const exactQueries = mockDislikes.mock.calls
            .map(([query]) => query)
            .filter((query) => query.where.entityId?.in);
        expect(exactQueries).toHaveLength(5);
        for (const query of exactQueries) {
            expect(query.take).toBeLessThanOrEqual(250);
            expect(query.where.userId).toBe("alice");
            expect(query.where.entityId.in.length).toBe(query.take);
        }
    });
});
