import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { readVerifiedMusicSourceRecording } from "../musicSources/verifiedMetadata";
import {
    buildPersonalizedRepeatExclusions,
    PERSONALIZED_LISTENING_LOOKBACK_MS,
    type PersonalizedRepeatObservation,
} from "../personalizedRepeatPolicy";

/** Exact native and live canonical identities; the last-day subset cannot be relaxed. */
export interface VerifiedSourceRepeatExclusions {
    ids: Set<string>;
    hardIds: Set<string>;
}

/** Account-owned direct listening, independently of sessions, embeddings or provider entitlement. */
export async function loadVerifiedSourceRepeatExclusions(
    userId: string,
    now: Date,
    check?: () => void,
): Promise<VerifiedSourceRepeatExclusions> {
    const observations: PersonalizedRepeatObservation[] = [];
    const identities: Array<{ token: string; ids: string[] }> = [];
    const mappingWhere: Prisma.TrackMappingWhereInput = {
        stale: false,
        canonicalRecording: {
            is: {
                mergedIntoId: null,
                identitySource: { not: "identity-merged" },
            },
        },
    };
    let cursor: string | undefined;
    let scanned = 0;
    while (scanned < 1_000) {
        check?.();
        const rows = await prisma.play.findMany({
            where: {
                userId,
                playedAt: {
                    gte: new Date(
                        now.getTime() - PERSONALIZED_LISTENING_LOOKBACK_MS,
                    ),
                    lte: now,
                },
                AND: [
                    {
                        OR: ["vk", "yandex"].map((provider) => ({
                            source: provider === "vk" ? "VK" : "YANDEX",
                            trackMusicSource: {
                                is: {
                                    provider,
                                    verifiedMetadata: { not: Prisma.AnyNull },
                                    metadataObservedAt: { not: null },
                                    metadataConnectionVersion: { gt: 0 },
                                },
                            },
                        })),
                    },
                    { OR: [{ outcome: null }, { outcome: { not: "failed" } }] },
                    {
                        OR: [
                            {
                                playedAt: {
                                    gt: new Date(now.getTime() - 86_400_000),
                                },
                            },
                            { listenedSeconds: { gte: 30 } },
                        ],
                    },
                ],
            },
            orderBy: [{ playedAt: "desc" }, { id: "asc" }],
            take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
                id: true,
                source: true,
                playedAt: true,
                listenedSeconds: true,
                outcome: true,
                trackMusicSource: {
                    select: {
                        provider: true,
                        providerTrackId: true,
                        verifiedMetadata: true,
                        metadataObservedAt: true,
                        metadataConnectionVersion: true,
                        mappings: {
                            where: mappingWhere,
                            take: 1,
                            select: {
                                canonicalRecording: {
                                    select: { canonicalKey: true },
                                },
                            },
                        },
                    },
                },
            },
        });
        check?.();
        scanned += rows.length;
        for (const row of rows) {
            const recording = readVerifiedMusicSourceRecording(
                row.trackMusicSource,
            );
            if (
                !recording ||
                row.source !== (recording.provider === "vk" ? "VK" : "YANDEX")
            )
                continue;
            const canonicalKey =
                row.trackMusicSource?.mappings[0]?.canonicalRecording
                    ?.canonicalKey;
            const token = `observation:${observations.length}`;
            identities.push({
                token,
                ids: [
                    `${recording.provider}:${recording.id}`,
                    ...(canonicalKey ? [canonicalKey] : []),
                ],
            });
            observations.push({
                track: { videoId: token, artist: "", title: "" },
                playedAt: row.playedAt,
                listenedSeconds: row.listenedSeconds,
                outcome: row.outcome,
            });
        }
        if (rows.length < 100) break;
        cursor = rows[rows.length - 1].id;
    }
    // Empty display fields deliberately prevent weak artist/title cross-source matching.
    const repeat = buildPersonalizedRepeatExclusions(observations, now);
    const ids = new Set<string>(),
        hardIds = new Set<string>();
    // The legacy policy may normalize provider IDs. Apply only its time/outcome
    // decision to opaque occurrence tokens and retain the actual identities verbatim.
    for (const identity of identities) {
        if (repeat.videoIds.has(identity.token))
            for (const id of identity.ids) ids.add(id);
        if (repeat.hardVideoIds.has(identity.token))
            for (const id of identity.ids) hardIds.add(id);
    }
    return { ids, hardIds };
}
