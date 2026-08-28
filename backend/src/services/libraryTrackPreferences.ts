import { randomUUID } from "node:crypto";
import { prisma } from "../utils/db";
import {
    resolveTrackPreference,
    normalizeTrackPreferenceSignal,
    TRACK_DISLIKE_ENTITY_TYPE,
    type ResolvedTrackPreference,
} from "./trackPreference";
import type { UnifiedTrackResponse } from "./unifiedTrackResponse";

const REMOTE_PREFERENCE_TRANSACTION_ATTEMPTS = 3;
const REMOTE_PREFERENCE_TRANSACTION_OPTIONS = {
    isolationLevel: "Serializable" as const,
    maxWait: 5_000,
    timeout: 10_000,
};
const REMOTE_PREFERENCE_READ_TRANSACTION_OPTIONS = {
    isolationLevel: "RepeatableRead" as const,
    maxWait: 5_000,
    timeout: 10_000,
};
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Canonical external identity used by remote-track preference persistence. */
export type RemoteTrackPreferenceReference =
    | {
          provider: "youtube";
          externalId: string;
      }
    | {
          provider: "tidal";
          externalId: string;
          tidalId: number;
      };

/** Materialized remote row targeted by a thumbs-up mutation. */
export type RemoteTrackLikeTarget =
    | { provider: "youtube"; trackYtMusicId: string }
    | { provider: "tidal"; trackTidalId: string };

/** Parse and canonicalize a supported remote track composite id. */
export function parseRemoteTrackPreferenceReference(
    compositeId: string,
): RemoteTrackPreferenceReference | null {
    if (compositeId.startsWith("yt:")) {
        const externalId = compositeId.slice(3).trim();
        return YOUTUBE_VIDEO_ID_PATTERN.test(externalId)
            ? {
                  provider: "youtube",
                  externalId,
              }
            : null;
    }

    if (!compositeId.startsWith("tidal:")) return null;
    const externalId = compositeId.slice(6).trim();
    if (!/^\d+$/.test(externalId)) return null;
    const tidalId = Number(externalId);
    if (!Number.isSafeInteger(tidalId) || tidalId <= 0) return null;
    return {
        provider: "tidal",
        externalId,
        tidalId,
    };
}

function canonicalRemotePreferenceId(
    reference: RemoteTrackPreferenceReference,
): string {
    return reference.provider === "tidal"
        ? `tidal:${reference.tidalId}`
        : `yt:${reference.externalId}`;
}

type RemotePreferenceClient = Pick<
    typeof prisma,
    | "dislikedEntity"
    | "likedRemoteTrack"
    | "remotePreferenceIntent"
    | "trackTidal"
    | "trackYtMusic"
>;

async function findRemoteLikedAt(
    client: RemotePreferenceClient,
    userId: string,
    reference: RemoteTrackPreferenceReference,
): Promise<Date | null> {
    if (reference.provider === "tidal") {
        const track = await client.trackTidal.findUnique({
            where: { tidalId: reference.tidalId },
            select: { id: true },
        });
        if (!track) return null;
        const liked = await client.likedRemoteTrack.findUnique({
            where: {
                userId_trackTidalId: {
                    userId,
                    trackTidalId: track.id,
                },
            },
            select: { likedAt: true },
        });
        return liked?.likedAt ?? null;
    }

    const track = await client.trackYtMusic.findUnique({
        where: { videoId: reference.externalId },
        select: { id: true },
    });
    if (!track) return null;
    const liked = await client.likedRemoteTrack.findUnique({
        where: {
            userId_trackYtMusicId: {
                userId,
                trackYtMusicId: track.id,
            },
        },
        select: { likedAt: true },
    });
    return liked?.likedAt ?? null;
}

async function loadRemoteTrackPreferenceWithClient(
    client: RemotePreferenceClient,
    userId: string,
    reference: RemoteTrackPreferenceReference,
): Promise<ResolvedTrackPreference> {
    const likedAt = await findRemoteLikedAt(client, userId, reference);
    const disliked = await client.dislikedEntity.findUnique({
        where: {
            userId_entityType_entityId: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: canonicalRemotePreferenceId(reference),
            },
        },
        select: { dislikedAt: true },
    });
    return resolveTrackPreference({
        likedAt,
        dislikedAt: disliked?.dislikedAt ?? null,
    });
}

/** Load one user's remote preference from a repeatable database snapshot. */
export async function loadRemoteTrackPreference(
    userId: string,
    reference: RemoteTrackPreferenceReference,
): Promise<ResolvedTrackPreference> {
    return prisma.$transaction(
        (tx) => loadRemoteTrackPreferenceWithClient(tx, userId, reference),
        REMOTE_PREFERENCE_READ_TRANSACTION_OPTIONS,
    );
}

type RemotePreferenceTransaction = RemotePreferenceClient;

async function clearRemoteLike(
    tx: RemotePreferenceTransaction,
    userId: string,
    reference: RemoteTrackPreferenceReference,
): Promise<void> {
    if (reference.provider === "tidal") {
        const track = await tx.trackTidal.findUnique({
            where: { tidalId: reference.tidalId },
            select: { id: true },
        });
        if (track) {
            await tx.likedRemoteTrack.deleteMany({
                where: { userId, trackTidalId: track.id },
            });
        }
        return;
    }

    const track = await tx.trackYtMusic.findUnique({
        where: { videoId: reference.externalId },
        select: { id: true },
    });
    if (track) {
        await tx.likedRemoteTrack.deleteMany({
            where: { userId, trackYtMusicId: track.id },
        });
    }
}

async function saveRemoteLike(
    tx: RemotePreferenceTransaction,
    userId: string,
    reference: RemoteTrackPreferenceReference,
    target: RemoteTrackLikeTarget | undefined,
    likedAt: Date,
): Promise<void> {
    if (reference.provider === "tidal") {
        if (!target || target.provider !== "tidal") {
            throw new TypeError("A materialized TIDAL target is required");
        }
        await tx.likedRemoteTrack.upsert({
            where: {
                userId_trackTidalId: {
                    userId,
                    trackTidalId: target.trackTidalId,
                },
            },
            create: { userId, trackTidalId: target.trackTidalId, likedAt },
            update: { likedAt },
        });
        return;
    }

    if (!target || target.provider !== "youtube") {
        throw new TypeError("A materialized YouTube target is required");
    }
    await tx.likedRemoteTrack.upsert({
        where: {
            userId_trackYtMusicId: {
                userId,
                trackYtMusicId: target.trackYtMusicId,
            },
        },
        create: { userId, trackYtMusicId: target.trackYtMusicId, likedAt },
        update: { likedAt },
    });
}

function isRetryableRemotePreferenceAbort(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const record = error as Record<string, unknown>;
    const meta =
        typeof record.meta === "object" && record.meta !== null
            ? (record.meta as Record<string, unknown>)
            : null;
    const adapter =
        typeof meta?.driverAdapterError === "object" &&
        meta.driverAdapterError !== null
            ? (meta.driverAdapterError as Record<string, unknown>)
            : null;
    const cause =
        typeof adapter?.cause === "object" && adapter.cause !== null
            ? (adapter.cause as Record<string, unknown>)
            : null;
    if (
        [record, meta, cause].some(
            (candidate) =>
                candidate?.code === "P2034" ||
                candidate?.code === "40001" ||
                candidate?.code === "40P01",
        )
    ) {
        return true;
    }
    const message =
        typeof record.message === "string" ? record.message.toLowerCase() : "";
    return (
        message.includes("could not serialize") || message.includes("deadlock")
    );
}

async function runRemotePreferenceTransaction<T>(
    operation: (tx: RemotePreferenceTransaction) => Promise<T>,
): Promise<T> {
    for (
        let attempt = 1;
        attempt <= REMOTE_PREFERENCE_TRANSACTION_ATTEMPTS;
        attempt += 1
    ) {
        try {
            return await prisma.$transaction(
                (tx) => operation(tx),
                REMOTE_PREFERENCE_TRANSACTION_OPTIONS,
            );
        } catch (error) {
            if (
                !isRetryableRemotePreferenceAbort(error) ||
                attempt === REMOTE_PREFERENCE_TRANSACTION_ATTEMPTS
            ) {
                throw error;
            }
        }
    }
    throw new Error(
        "Remote preference transaction retry bound was not enforced",
    );
}

/** Reserve the durable latest-request token before provider materialization. */
export async function reserveRemoteTrackPreferenceIntent({
    userId,
    reference,
    requestedAt,
}: {
    userId: string;
    reference: RemoteTrackPreferenceReference;
    requestedAt: Date;
}): Promise<string> {
    const token = randomUUID();
    const remoteTrackId = canonicalRemotePreferenceId(reference);
    await runRemotePreferenceTransaction(async (tx) => {
        await tx.remotePreferenceIntent.upsert({
            where: {
                userId_remoteTrackId: { userId, remoteTrackId },
            },
            create: { userId, remoteTrackId, token, requestedAt },
            update: { token, requestedAt },
        });
    });
    return token;
}

/** Remove only the still-current failed request token. */
export async function cancelRemoteTrackPreferenceIntent({
    userId,
    reference,
    intentToken,
}: {
    userId: string;
    reference: RemoteTrackPreferenceReference;
    intentToken: string;
}): Promise<void> {
    const remoteTrackId = canonicalRemotePreferenceId(reference);
    await runRemotePreferenceTransaction(async (tx) => {
        await tx.remotePreferenceIntent.deleteMany({
            where: { userId, remoteTrackId, token: intentToken },
        });
    });
}

async function mutateRemotePreference(
    tx: RemotePreferenceTransaction,
    userId: string,
    reference: RemoteTrackPreferenceReference,
    signal: NormalizedTrackPreferenceSignal,
    now: Date,
    likedTarget: RemoteTrackLikeTarget | undefined,
): Promise<void> {
    const dislikeWhere = {
        userId,
        entityType: TRACK_DISLIKE_ENTITY_TYPE,
        entityId: canonicalRemotePreferenceId(reference),
    };

    if (signal === "thumbs_up") {
        await tx.dislikedEntity.deleteMany({ where: dislikeWhere });
        await saveRemoteLike(tx, userId, reference, likedTarget, now);
        return;
    }

    await clearRemoteLike(tx, userId, reference);
    if (signal === "thumbs_down") {
        await tx.dislikedEntity.upsert({
            where: {
                userId_entityType_entityId: dislikeWhere,
            },
            create: { ...dislikeWhere, dislikedAt: now },
            update: { dislikedAt: now },
        });
        return;
    }

    await tx.dislikedEntity.deleteMany({ where: dislikeWhere });
}

/**
 * Atomically apply one remote preference signal, retrying bounded PostgreSQL
 * serialization aborts. Only the latest reserved request token may mutate the
 * like/dislike rows, so slow older materialization cannot overwrite new intent.
 */
export async function applyRemoteTrackPreferenceSignal({
    userId,
    reference,
    signal,
    now,
    intentToken,
    likedTarget,
}: {
    userId: string;
    reference: RemoteTrackPreferenceReference;
    signal: NormalizedTrackPreferenceSignal;
    now: Date;
    intentToken: string;
    likedTarget?: RemoteTrackLikeTarget;
}): Promise<ResolvedTrackPreference> {
    const remoteTrackId = canonicalRemotePreferenceId(reference);
    return runRemotePreferenceTransaction(async (tx) => {
        const claim = await tx.remotePreferenceIntent.updateMany({
            where: { userId, remoteTrackId, token: intentToken },
            data: { token: intentToken },
        });
        if (claim.count === 0) {
            return loadRemoteTrackPreferenceWithClient(tx, userId, reference);
        }

        await mutateRemotePreference(
            tx,
            userId,
            reference,
            signal,
            now,
            likedTarget,
        );
        return resolveTrackPreference({
            likedAt: signal === "thumbs_up" ? now : null,
            dislikedAt: signal === "thumbs_down" ? now : null,
        });
    });
}

export const formatTrackPreferenceResponse = (
    trackId: string,
    preference: ResolvedTrackPreference,
) => ({
    trackId,
    signal: preference.signal,
    state: preference.state,
    score: preference.score,
    likedAt: preference.likedAt ? preference.likedAt.toISOString() : null,
    dislikedAt: preference.dislikedAt
        ? preference.dislikedAt.toISOString()
        : null,
    updatedAt: preference.updatedAt ? preference.updatedAt.toISOString() : null,
});

export type NormalizedTrackPreferenceSignal = Exclude<
    ReturnType<typeof normalizeTrackPreferenceSignal>,
    null
>;

export const formatAlbumPreferenceResponse = (
    albumId: string,
    trackCount: number,
    preference: ResolvedTrackPreference,
) => ({
    albumId,
    trackCount,
    signal: preference.signal,
    state: preference.state,
    score: preference.score,
    likedAt: preference.likedAt ? preference.likedAt.toISOString() : null,
    dislikedAt: preference.dislikedAt
        ? preference.dislikedAt.toISOString()
        : null,
    updatedAt: preference.updatedAt ? preference.updatedAt.toISOString() : null,
});

export const hasConnectedProviderToken = (
    value: string | null | undefined,
): boolean => typeof value === "string" && value.trim().length > 0;

export const toLikedResponseTrack = (
    normalized: UnifiedTrackResponse,
    likedAt: Date,
) => {
    const likedAtIso = likedAt.toISOString();
    const base = {
        id: normalized.id,
        title: normalized.title,
        duration: normalized.duration,
        trackNo: normalized.trackNo,
        filePath: normalized.filePath ?? null,
        likedAt: likedAtIso,
        source: normalized.source,
        provider: normalized.provider,
        artist: normalized.artist,
        album: normalized.album,
    };

    if (normalized.source === "tidal") {
        return {
            ...base,
            streamSource: "tidal" as const,
            tidalTrackId: normalized.provider.tidalTrackId,
        };
    }

    if (normalized.source === "youtube") {
        return {
            ...base,
            streamSource: "youtube" as const,
            youtubeVideoId: normalized.provider.youtubeVideoId,
        };
    }

    if (normalized.source === "federated") {
        return { ...base, streamSource: "peer" as const };
    }

    return base;
};

export const applyTrackPreferenceSignalToTrackIds = async (
    tx: {
        likedTrack: {
            deleteMany: typeof prisma.likedTrack.deleteMany;
            createMany: typeof prisma.likedTrack.createMany;
        };
        dislikedEntity: {
            deleteMany: typeof prisma.dislikedEntity.deleteMany;
            createMany: typeof prisma.dislikedEntity.createMany;
        };
    },
    userId: string,
    trackIds: string[],
    signal: NormalizedTrackPreferenceSignal,
    now: Date,
) => {
    if (trackIds.length === 0) {
        return;
    }

    if (signal === "thumbs_up") {
        await tx.dislikedEntity.deleteMany({
            where: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: { in: trackIds },
            },
        });
        await tx.likedTrack.deleteMany({
            where: {
                userId,
                trackId: { in: trackIds },
            },
        });
        await tx.likedTrack.createMany({
            data: trackIds.map((trackId) => ({
                userId,
                trackId,
                likedAt: now,
            })),
            skipDuplicates: true,
        });
        return;
    }

    if (signal === "thumbs_down") {
        await tx.likedTrack.deleteMany({
            where: {
                userId,
                trackId: { in: trackIds },
            },
        });
        await tx.dislikedEntity.deleteMany({
            where: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: { in: trackIds },
            },
        });
        await tx.dislikedEntity.createMany({
            data: trackIds.map((trackId) => ({
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: trackId,
                dislikedAt: now,
            })),
            skipDuplicates: true,
        });
        return;
    }

    await tx.likedTrack.deleteMany({
        where: {
            userId,
            trackId: { in: trackIds },
        },
    });
    await tx.dislikedEntity.deleteMany({
        where: {
            userId,
            entityType: TRACK_DISLIKE_ENTITY_TYPE,
            entityId: { in: trackIds },
        },
    });
};

/** Loads per-track preference scores through the supplied database client. */
export const buildTrackPreferenceScoreMapForUser = async (
    userId: string | undefined,
    trackIds: string[],
    client: Pick<typeof prisma, "likedTrack" | "dislikedEntity"> = prisma,
): Promise<Map<string, number>> => {
    if (!userId || trackIds.length === 0) {
        return new Map<string, number>();
    }

    const uniqueTrackIds = Array.from(
        new Set(
            trackIds.filter(
                (trackId): trackId is string =>
                    typeof trackId === "string" && trackId.length > 0,
            ),
        ),
    );
    if (uniqueTrackIds.length === 0) {
        return new Map<string, number>();
    }

    const [likedEntries, dislikedEntries] = await Promise.all([
        client.likedTrack.findMany({
            where: {
                userId,
                trackId: { in: uniqueTrackIds },
            },
            select: {
                trackId: true,
                likedAt: true,
            },
        }),
        client.dislikedEntity.findMany({
            where: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: { in: uniqueTrackIds },
            },
            select: {
                entityId: true,
                dislikedAt: true,
            },
        }),
    ]);

    const likedByTrackId = new Map<string, Date>();
    for (const entry of likedEntries) {
        likedByTrackId.set(entry.trackId, entry.likedAt);
    }

    const dislikedByTrackId = new Map<string, Date>();
    for (const entry of dislikedEntries) {
        dislikedByTrackId.set(entry.entityId, entry.dislikedAt);
    }

    const scoreMap = new Map<string, number>();
    for (const trackId of uniqueTrackIds) {
        const preference = resolveTrackPreference({
            likedAt: likedByTrackId.get(trackId) ?? null,
            dislikedAt: dislikedByTrackId.get(trackId) ?? null,
        });
        if (preference.score !== 0) {
            scoreMap.set(trackId, preference.score);
        }
    }

    return scoreMap;
};
