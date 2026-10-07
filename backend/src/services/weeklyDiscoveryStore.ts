import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
    buildRecommendationAlbumKey,
    normalizeRecommendationArtistKey,
} from "./recommendations/identityKeys";

/** Directly playable, metadata-only discovery saved for one account/week. */
export const weeklyDiscoveryTrackSchema = z
    .object({
        id: z.string().min(1).max(96),
        youtubeVideoId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        title: z.string().trim().min(1).max(400),
        artist: z.string().trim().min(1).max(300),
        album: z.string().max(400),
        albumId: z.string().max(256),
        duration: z.number().finite().min(45).max(900),
        coverUrl: z.string().url().max(2048).nullable(),
        sourceType: z.literal("youtube"),
        streamSource: z.literal("youtube"),
        available: z.literal(true),
        isLiked: z.literal(false),
        likedAt: z.null(),
        similarity: z.literal(0),
        tier: z.literal("explore"),
    })
    .strict();

/** Persisted weekly discovery track, without client attribution fields. */
export type WeeklyDiscoveryTrack = z.infer<typeof weeklyDiscoveryTrackSchema>;

const snapshotSchema = z
    .object({
        weeklyDiscovery: z
            .object({
                version: z.literal(1),
                weekStart: z.string().datetime(),
                cleared: z.boolean(),
                tracks: z.array(weeklyDiscoveryTrackSchema).max(40),
            })
            .strict(),
    })
    .strict();
const ALGORITHM = "weekly-discovery-v1";
const selection = { id: true, context: true } as const;

/** Validated weekly snapshot owned by its generation row. */
export interface StoredWeeklyDiscovery {
    id: string;
    weekStart: string;
    cleared: boolean;
    tracks: WeeklyDiscoveryTrack[];
}

/** Store boundary; provider requests must finish before calling save. */
export interface WeeklyDiscoveryStorage {
    find(
        userId: string,
        weekStart: string,
    ): Promise<StoredWeeklyDiscovery | null>;
    save(
        userId: string,
        weekStart: string,
        tracks: WeeklyDiscoveryTrack[],
        latencyMs: number,
    ): Promise<StoredWeeklyDiscovery>;
    clear(userId: string, weekStart: string): Promise<number>;
}

function decode(
    row: { id: string; context: unknown },
    weekStart: string,
): StoredWeeklyDiscovery {
    const value = snapshotSchema.parse(row.context).weeklyDiscovery;
    if (
        value.weekStart !== weekStart ||
        (value.cleared && value.tracks.length > 0)
    ) {
        throw new Error("Invalid weekly discovery snapshot");
    }
    return { id: row.id, ...value };
}

function scope(userId: string, weekStart: string) {
    return {
        userId,
        algorithm: ALGORITHM,
        sessionId: `discover-weekly:${weekStart}`,
        surface: "made-for-you",
        served: true,
    };
}

function context(
    weekStart: string,
    tracks: WeeklyDiscoveryTrack[],
    cleared: boolean,
): Prisma.InputJsonObject {
    const snapshot = snapshotSchema.parse({
        weeklyDiscovery: { version: 1, weekStart, cleared, tracks },
    });
    return {
        weeklyDiscovery: {
            ...snapshot.weeklyDiscovery,
            tracks: snapshot.weeklyDiscovery.tracks.map((track) => ({
                ...track,
            })),
        },
    };
}

function retryable(error: unknown): boolean {
    if (
        z.object({ code: z.enum(["P2034", "40001", "40P01"]) }).safeParse(error)
            .success
    )
        return true;
    if (
        z
            .object({
                name: z.literal("DriverAdapterError"),
                cause: z.object({
                    kind: z.literal("TransactionWriteConflict"),
                }),
            })
            .safeParse(error).success
    )
        return true;
    const result = z
        .object({
            code: z.string().optional(),
            meta: z
                .object({
                    driverAdapterError: z
                        .object({
                            cause: z
                                .object({
                                    code: z.string().optional(),
                                    originalCode: z.string().optional(),
                                })
                                .passthrough()
                                .optional(),
                        })
                        .passthrough()
                        .optional(),
                })
                .passthrough()
                .optional(),
        })
        .passthrough()
        .safeParse(error);
    if (!result.success) return false;
    return [
        result.data.code,
        result.data.meta?.driverAdapterError?.cause?.code,
        result.data.meta?.driverAdapterError?.cause?.originalCode,
    ].some((code) => code === "P2034" || code === "40001" || code === "40P01");
}

/** Serializes first-create/clear across API processes using PostgreSQL SSI. */
export class PrismaWeeklyDiscoveryStore implements WeeklyDiscoveryStorage {
    constructor(
        private readonly client: Pick<
            PrismaClient,
            "recommendationGeneration" | "$transaction"
        >,
    ) {}

    /** Read the owned, current-week snapshot without provider I/O. */
    async find(
        userId: string,
        weekStart: string,
    ): Promise<StoredWeeklyDiscovery | null> {
        const row = await this.client.recommendationGeneration.findFirst({
            where: scope(userId, weekStart),
            select: selection,
        });
        return row ? decode(row, weekStart) : null;
    }

    private async transact<T>(
        operation: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.client.$transaction(operation, {
                    isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                    maxWait: 2000,
                    timeout: 5000,
                });
            } catch (error) {
                if (attempt >= 2 || !retryable(error)) throw error;
                await new Promise((resolve) =>
                    setTimeout(resolve, 10 * (attempt + 1)),
                );
            }
        }
    }

    /** Save only a full-enough batch; a concurrent save or clear wins unchanged. */
    async save(
        userId: string,
        weekStart: string,
        tracks: WeeklyDiscoveryTrack[],
        latencyMs: number,
    ): Promise<StoredWeeklyDiscovery> {
        if (tracks.length < 20 || tracks.length > 40)
            throw new RangeError("Weekly discovery needs 20 to 40 tracks");
        const savedContext = context(weekStart, tracks, false);
        return this.transact(async (tx) => {
            const existing = await tx.recommendationGeneration.findFirst({
                where: scope(userId, weekStart),
                select: selection,
            });
            if (existing) return decode(existing, weekStart);
            const row = await tx.recommendationGeneration.create({
                data: {
                    ...scope(userId, weekStart),
                    direction: "new",
                    degradedSources: [],
                    latencyMs,
                    context: savedContext,
                    exposures: {
                        create: tracks.map((track, position) => ({
                            userId,
                            provider: "youtube",
                            providerTrackId: track.youtubeVideoId,
                            canonicalKey: `yt:${track.youtubeVideoId}`,
                            artistKey: normalizeRecommendationArtistKey(
                                track.artist,
                            ),
                            albumKey: buildRecommendationAlbumKey(
                                track.artist,
                                track.album,
                            ),
                            source: "weekly-discovery",
                            position,
                        })),
                    },
                },
                select: selection,
            });
            return decode(row, weekStart);
        });
    }

    /** Keep an empty tombstone through this week, retaining play attribution. */
    async clear(userId: string, weekStart: string): Promise<number> {
        return this.transact(async (tx) => {
            const existing = await tx.recommendationGeneration.findFirst({
                where: scope(userId, weekStart),
                select: selection,
            });
            const clearedContext = context(weekStart, [], true);
            if (existing) {
                const count = decode(existing, weekStart).tracks.length;
                await tx.recommendationGeneration.update({
                    where: { id: existing.id },
                    data: { context: clearedContext },
                });
                return count;
            }
            await tx.recommendationGeneration.create({
                data: {
                    ...scope(userId, weekStart),
                    direction: "new",
                    degradedSources: [],
                    latencyMs: 0,
                    context: clearedContext,
                },
            });
            return 0;
        });
    }
}
