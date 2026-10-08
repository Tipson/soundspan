import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { readVerifiedMusicSourceRecording } from "../musicSources/verifiedMetadata";

interface MusicSourceFeedbackReference {
    provider: "vk" | "yandex";
    providerTrackId: string;
}

const namespaceSelect = {
    provider: true,
    providerTrackId: true,
    verifiedMetadata: true,
    metadataObservedAt: true,
    metadataConnectionVersion: true,
} as const;

const confirmedNamespaceWhere: Prisma.TrackMusicSourceWhereInput = {
    provider: { in: ["vk", "yandex"] },
    verifiedMetadata: { not: Prisma.AnyNull },
    metadataObservedAt: { not: null },
    metadataConnectionVersion: { gt: 0 },
};

const liveCanonicalWhere: Prisma.CanonicalRecordingWhereInput = {
    mergedIntoId: null,
    identitySource: { not: "identity-merged" },
};

/** Reserved direct prefixes cannot fall through to a local or YouTube identity. */
export function isMusicSourceFeedbackReference(value: string): boolean {
    const trimmed = value.trim();
    return trimmed.startsWith("vk:") || trimmed.startsWith("yandex:");
}

function parseReference(value: string): MusicSourceFeedbackReference | null {
    const match = /^(vk|yandex):(.+)$/.exec(value);
    if (!match) return null;
    const provider = match[1] as "vk" | "yandex";
    const providerTrackId = match[2];
    if (
        !(provider === "vk" ? /^-?\d{1,20}_\d{1,20}$/ : /^\d{1,20}$/).test(
            providerTrackId,
        )
    )
        return null;
    return { provider, providerTrackId };
}

async function loadVerifiedMappings(
    references: MusicSourceFeedbackReference[],
) {
    if (references.length === 0) return [];
    const requested = new Set(
        references.map((ref) => `${ref.provider}:${ref.providerTrackId}`),
    );
    const identities: Prisma.TrackMappingWhereInput[] = [];
    for (const provider of ["vk", "yandex"] as const) {
        const providerTrackIds = references
            .filter((ref) => ref.provider === provider)
            .map((ref) => ref.providerTrackId);
        if (providerTrackIds.length > 0)
            identities.push({
                trackMusicSource: {
                    is: {
                        ...confirmedNamespaceWhere,
                        provider,
                        providerTrackId: { in: providerTrackIds },
                    },
                },
            });
    }
    const rows = await prisma.trackMapping.findMany({
        where: {
            stale: false,
            canonicalRecording: { is: liveCanonicalWhere },
            OR: identities,
        },
        take: requested.size,
        select: {
            trackMusicSource: { select: namespaceSelect },
            canonicalRecording: { select: { id: true, canonicalKey: true } },
        },
    });
    return rows.flatMap((row) => {
        const recording = readVerifiedMusicSourceRecording(
            row.trackMusicSource,
        );
        if (
            !recording ||
            !requested.has(`${recording.provider}:${recording.id}`) ||
            !row.canonicalRecording
        )
            return [];
        return [row.canonicalRecording];
    });
}

/** Read a bounded fourth saved-vector reserve, validating stored facts before the global quota. */
export async function loadVerifiedLikedCanonicalIds(
    userId: string,
    limit: number,
): Promise<string[]> {
    const ownedMappings: Prisma.TrackMappingWhereInput = {
        stale: false,
        trackMusicSource: {
            is: {
                ...confirmedNamespaceWhere,
                likedTracks: { some: { userId } },
            },
        },
    };
    const boundedLimit = Number.isFinite(limit)
        ? Math.max(0, Math.min(500, Math.trunc(limit)))
        : 0;
    const ids = new Set<string>();
    let cursor: string | undefined;
    let scanned = 0;
    // Scan at most ten bounded pages. Duplicate or weak namespaces do not consume
    // a canonical slot; pathological stored data may exhaust this defensive ceiling.
    while (ids.size < boundedLimit && scanned < 5_000) {
        const rows = await prisma.trackMapping.findMany({
            where: {
                ...ownedMappings,
                canonicalRecording: {
                    is: {
                        ...liveCanonicalWhere,
                        embeddings: {
                            some: {
                                space: { status: "active", cleaningAt: null },
                            },
                        },
                    },
                },
            },
            orderBy: [
                { canonicalRecording: { createdAt: "desc" } },
                { canonicalRecordingId: "asc" },
                { id: "asc" },
            ],
            take: 500,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
                id: true,
                trackMusicSource: { select: namespaceSelect },
                canonicalRecording: { select: { id: true } },
            },
        });
        scanned += rows.length;
        for (const row of rows) {
            if (
                readVerifiedMusicSourceRecording(row.trackMusicSource) &&
                row.canonicalRecording
            )
                ids.add(row.canonicalRecording.id);
            if (ids.size === boundedLimit) break;
        }
        if (rows.length < 500) break;
        cursor = rows[rows.length - 1].id;
    }
    return [...ids];
}

/** Exact dislikes resolve without audio analysis, shared writes, or current provider entitlement. */
export async function loadVerifiedDislikedCanonicalKeys(
    userId: string,
    limit: number,
): Promise<string[]> {
    const dislikes = await Promise.all(
        ["vk:", "yandex:"].map((prefix) =>
            prisma.dislikedEntity.findMany({
                where: {
                    userId,
                    entityType: "track",
                    entityId: { startsWith: prefix },
                },
                orderBy: { dislikedAt: "desc" },
                take: limit,
                select: { entityId: true },
            }),
        ),
    );
    const references = dislikes
        .flat()
        .flatMap((row) => parseReference(row.entityId) ?? []);
    return (await loadVerifiedMappings(references)).map(
        (row) => row.canonicalKey,
    );
}

/** Read an exact direct seed mapping; malformed/unconfirmed namespaces stay neutral. */
export async function loadVerifiedSeedCanonicalId(
    seedId: string,
): Promise<string | null> {
    const reference = parseReference(seedId);
    if (!reference) return null;
    return (await loadVerifiedMappings([reference]))[0]?.id ?? null;
}

/** Owned session evidence resolved through confirmed facts; never private display snapshots. */
export interface VerifiedMusicSourceSessionPlay {
    canonicalRecordingId: string;
    playedAt: Date;
    outcome: string | null;
    completionRatio: number | null;
    listenedSeconds: number | null;
}

/** Read at most 300 eligible direct plays before the consumer's real-vector/signal quota. */
export async function loadVerifiedSessionPlays(
    userId: string,
    sessionId: string,
): Promise<VerifiedMusicSourceSessionPlay[]> {
    const mappingWhere: Prisma.TrackMappingWhereInput = {
        stale: false,
        canonicalRecording: {
            is: {
                ...liveCanonicalWhere,
                embeddings: {
                    some: { space: { status: "active", cleaningAt: null } },
                },
            },
        },
    };
    const plays: VerifiedMusicSourceSessionPlay[] = [];
    let cursor: string | undefined;
    let scanned = 0;
    while (scanned < 300) {
        const rows = await prisma.play.findMany({
            where: {
                userId,
                recommendationSessionId: sessionId,
                AND: [
                    {
                        OR: ["vk", "yandex"].map((provider) => ({
                            source: provider === "vk" ? "VK" : "YANDEX",
                            trackMusicSource: {
                                is: {
                                    ...confirmedNamespaceWhere,
                                    provider,
                                    mappings: { some: mappingWhere },
                                },
                            },
                        })),
                    },
                    {
                        OR: [{ outcome: null }, { outcome: { not: "failed" } }],
                    },
                ],
            },
            orderBy: [{ playedAt: "desc" }, { id: "asc" }],
            take: 30,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
                id: true,
                source: true,
                playedAt: true,
                outcome: true,
                completionRatio: true,
                listenedSeconds: true,
                trackMusicSource: {
                    select: {
                        ...namespaceSelect,
                        mappings: {
                            where: mappingWhere,
                            take: 1,
                            select: { canonicalRecordingId: true },
                        },
                    },
                },
            },
        });
        scanned += rows.length;
        for (const row of rows) {
            const recording = readVerifiedMusicSourceRecording(
                row.trackMusicSource,
            );
            const canonicalRecordingId =
                row.trackMusicSource?.mappings[0]?.canonicalRecordingId;
            if (
                !recording ||
                !canonicalRecordingId ||
                row.source !== (recording.provider === "vk" ? "VK" : "YANDEX")
            )
                continue;
            plays.push({
                canonicalRecordingId,
                playedAt: row.playedAt,
                outcome: row.outcome,
                completionRatio: row.completionRatio,
                listenedSeconds: row.listenedSeconds,
            });
        }
        if (rows.length < 30) break;
        cursor = rows[rows.length - 1].id;
    }
    return plays;
}
