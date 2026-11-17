import type { PrismaClient } from "@prisma/client";

const mockDatabase = { $transaction: jest.fn() };
jest.mock("../../../utils/db", () => ({ prisma: mockDatabase }));
jest.mock("../../../config", () => ({ config: {} }));
jest.mock("../../../utils/logger", () => {
    const logger = { warn: jest.fn(), child: jest.fn() };
    logger.child.mockReturnValue(logger);
    return { logger };
});

import { createPlayAccounting } from "../../playAccounting";
import { applyLocalTrackPreferenceSignal } from "../../libraryTrackPreferences";
import type { PlayEngagement } from "../../playAccountingProtocol";
import {
    RecommendationFeatureStore,
    type RecommendationSessionRow,
} from "../featureStore";
import {
    RecommendationEngine,
    type RecordEngineGenerationInput,
} from "../engine";
import type { RecommendRequest, RecommendationCandidate } from "../types";

const now = new Date("2026-11-17T12:00:00Z");
type StoredPlay = RecommendationSessionRow & {
    id: string;
    userId: string;
    localAttributionState: "NO_TARGET";
};

/** Transaction/row I/O is in memory; writers, taste transforms and ranking are real. */
function fixture() {
    const plays = new Map<string, StoredPlay>();
    const likes = new Map<string, Date>();
    const dislikes = new Map<string, Date>();
    const candidates: RecommendationCandidate[] = [
        "positive",
        "skip",
        "error",
    ].flatMap((group, axis) =>
        Array.from({ length: 4 }, (_, i) => ({
            id: `${group}-${i}`,
            canonicalKey: `canonical:${group}-${i}`,
            canonicalRecordingId: `${group}-${i}`,
            title: `${group} recording ${i}`,
            artist: { id: null, name: `${group} artist ${Math.floor(i / 2)}` },
            album: { id: null, title: `${group} album ${i}`, coverArt: null },
            duration: 180,
            source: "library" as const,
            streamSource: "library" as const,
            provider: { tidalTrackId: null, youtubeVideoId: null },
            candidateSources: ["library"],
            providerPrior: group === "skip" ? 1.2 : group === "error" ? 1.1 : 1,
            embedding: [0, 1, 2].map((dimension) =>
                dimension === axis ? 1 : 0,
            ),
            lane: i < 2 ? ("quickPicks" as const) : ("discovery" as const),
        })),
    );
    const vector = (id: string) =>
        candidates.find((candidate) => candidate.id === id)!.embedding!;
    const key = (owner: string, id: string) => `${owner}/${id}`;
    const transaction = {
        $queryRaw: async (_query: TemplateStringsArray, owner: string) => [
            { id: owner, epoch: 0 },
        ],
        play: {
            findFirst: async ({
                where,
            }: {
                where: { id: string; userId: string };
            }) => {
                const row = plays.get(where.id);
                return row?.userId === where.userId ? row : null;
            },
            updateMany: async ({
                where,
                data,
            }: {
                where: { id: string; userId: string };
                data: PlayEngagement;
            }) => {
                const row = plays.get(where.id);
                if (!row || row.userId !== where.userId) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            },
        },
        likedTrack: {
            upsert: async ({
                create,
            }: {
                create: { userId: string; trackId: string; likedAt: Date };
            }) => {
                likes.set(key(create.userId, create.trackId), create.likedAt);
            },
            deleteMany: async ({
                where,
            }: {
                where: { userId: string; trackId: string };
            }) => {
                likes.delete(key(where.userId, where.trackId));
            },
            findUnique: async ({
                where,
            }: {
                where: { userId_trackId: { userId: string; trackId: string } };
            }) => {
                const ref = where.userId_trackId;
                const likedAt = likes.get(key(ref.userId, ref.trackId));
                return likedAt ? { likedAt } : null;
            },
        },
        dislikedEntity: {
            upsert: async ({
                create,
            }: {
                create: { userId: string; entityId: string; dislikedAt: Date };
            }) => {
                dislikes.set(
                    key(create.userId, create.entityId),
                    create.dislikedAt,
                );
            },
            deleteMany: async ({
                where,
            }: {
                where: { userId: string; entityId: string };
            }) => {
                dislikes.delete(key(where.userId, where.entityId));
            },
            findUnique: async ({
                where,
            }: {
                where: {
                    userId_entityType_entityId: {
                        userId: string;
                        entityId: string;
                    };
                };
            }) => {
                const ref = where.userId_entityType_entityId;
                const dislikedAt = dislikes.get(key(ref.userId, ref.entityId));
                return dislikedAt ? { dislikedAt } : null;
            },
        },
    };
    mockDatabase.$transaction.mockImplementation(async (operation) =>
        operation(transaction),
    );
    const accounting = createPlayAccounting(
        mockDatabase as unknown as PrismaClient,
        {
            newCreationsEnabled: false,
            replaySupported: false,
        },
        () => now,
    );
    const rows = (owner: string) =>
        [...plays.values()].filter((play) => play.userId === owner);
    const vectors = (values: Map<string, Date>, owner: string) =>
        candidates
            .filter((candidate) => values.has(key(owner, candidate.id)))
            .map((candidate) => candidate.embedding!);
    const tasteReads = jest.fn(async (owner: string) => rows(owner));
    const store = new RecommendationFeatureStore({
        loadCanonicalFeatures: async () => [],
        loadTasteRows: tasteReads,
        loadLikedEmbeddings: async (owner) => vectors(likes, owner),
        loadDislikedEmbeddings: async (owner) => vectors(dislikes, owner),
        loadDislikedCanonicalKeys: async (owner) =>
            candidates
                .filter((candidate) => dislikes.has(key(owner, candidate.id)))
                .map((candidate) => candidate.canonicalKey),
        loadSeedCanonicalRecordingId: async () => null,
        loadSessionRows: async (owner) => rows(owner),
        loadContextRows: async () => [],
        now: () => now,
    });
    const generations: RecordEngineGenerationInput[] = [];
    const engine = new RecommendationEngine(
        {
            mode: "active",
            hybridRolloutPercent: 100,
            explorationRate: 0,
            loadCandidates: async () => ({
                candidates,
                nextCursor: 1,
                degradedSources: [],
            }),
            resolveCanonical: async (candidate) => ({
                id: candidate.canonicalRecordingId!,
                canonicalKey: candidate.canonicalKey,
                verifiedCanonicalKey: candidate.canonicalKey,
            }),
            loadRecentExposures: async () => [],
            loadDislikedCanonicalKeys: (owner) =>
                store.loadDislikedCanonicalKeys(owner),
            loadTasteContext: (owner, request) =>
                store.loadTasteContext(owner, { sessionId: request.sessionId }),
            recordGeneration: async (generation) => {
                generations.push(generation);
                return `generation-${generations.length}`;
            },
            scheduleHotSet: async () => {},
            now: () => now,
        },
        { recordGeneration: () => {} },
    );
    let nextPlay = 0;
    return {
        generations,
        tasteReads,
        async continuation(owner = "alice", limit = 6) {
            const request: RecommendRequest = {
                userId: owner,
                sessionId: "feedback-fixture-session",
                intent: { surface: "wave", direction: "for-you" },
                limit,
                perLaneLimit: 2,
            };
            return (await engine.recommend(request)).tracks;
        },
        preference(
            trackId: string,
            signal: "thumbs_up" | "thumbs_down" | "clear",
            owner = "alice",
        ) {
            return applyLocalTrackPreferenceSignal({
                userId: owner,
                trackId,
                signal,
                now,
            });
        },
        async engagement(
            trackId: string,
            engagement: PlayEngagement,
            owner = "alice",
        ) {
            const id = `play-${++nextPlay}`;
            plays.set(id, {
                id,
                userId: owner,
                localAttributionState: "NO_TARGET",
                embedding: vector(trackId),
                playedAt: now,
                outcome: null,
                completionRatio: null,
                listenedSeconds: null,
            });
            return accounting.updateEngagement(owner, id, engagement);
        },
    };
}

describe("persisted feedback writers → fresh taste → actual continuation", () => {
    it.each(["like", "completed", "early-skip", "failed", "dislike"] as const)(
        "%s changes only its intended signal and leaves another owner unchanged",
        async (signal) => {
            const app = fixture();
            const first = await app.continuation();
            const other = await app.continuation("bob");
            expect(first[0].id).toBe("skip-0");
            if (signal === "like")
                await app.preference("positive-0", "thumbs_up");
            else if (signal === "dislike")
                await app.preference("skip-0", "thumbs_down");
            else
                await app.engagement(
                    signal === "completed"
                        ? "positive-0"
                        : signal === "failed"
                          ? "error-0"
                          : "skip-0",
                    {
                        outcome: signal === "early-skip" ? "skipped" : signal,
                        listenedSeconds: signal === "completed" ? 180 : 8,
                        completionRatio: signal === "completed" ? 1 : 8 / 180,
                    },
                );
            const next = await app.continuation();
            if (signal === "like" || signal === "completed")
                expect(next[0].id).toMatch(/^positive-/);
            if (signal === "early-skip")
                expect(next[0].id).not.toMatch(/^skip-/);
            if (signal === "failed") expect(next).toEqual(first);
            if (signal === "dislike") {
                expect(next.some((track) => track.id === "skip-0")).toBe(false);
                await app.preference("skip-0", "clear");
                expect((await app.continuation())[0].id).toBe("skip-0");
            }
            expect(await app.continuation("bob")).toEqual(other);
            expect(
                app.tasteReads.mock.calls.some(([owner]) => owner === "alice"),
            ).toBe(true);
        },
    );

    it("does not generate during feedback writes and respects the requested familiar lane bound after a positive burst", async () => {
        const app = fixture();
        await app.continuation();
        const generationCount = app.generations.length;
        for (let i = 0; i < 25; i++) {
            await app.preference("positive-0", "thumbs_up");
            await app.engagement("positive-0", {
                outcome: "completed",
                listenedSeconds: 180,
                completionRatio: 1,
            });
        }
        expect(app.generations).toHaveLength(generationCount);
        const next = await app.continuation();
        expect(app.generations).toHaveLength(generationCount + 1);
        expect(
            next.filter((track) => track.lane === "quickPicks").length,
        ).toBeLessThanOrEqual(2);
        expect(next.some((track) => track.lane === "discovery")).toBe(true);
    });
});
