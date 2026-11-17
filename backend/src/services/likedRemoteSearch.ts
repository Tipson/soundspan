import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { escapeLikePattern } from "../utils/likePattern";
import { toLikedResponseTrack } from "./libraryTrackPreferences";
import { toVerifiedMusicSourceLikedTrack } from "./musicSourceLikedTrack";
import { normalizeYtMusicTrack } from "./unifiedTrackResponse";

/** Account and raw database page for a persisted external-liked search. */
export interface LikedRemoteSearchOptions {
    userId: string;
    query: string;
    offset: number;
    limit: number;
}

/** Existing liked-playlist DTOs, without inferred album or recording authority. */
export type LikedRemoteSearchTrack =
    | ReturnType<typeof toLikedResponseTrack>
    | NonNullable<ReturnType<typeof toVerifiedMusicSourceLikedTrack>>;

/** Raw-page progress remains available when invalid attestations are omitted. */
export interface LikedRemoteSearchResult {
    streamingTracks: LikedRemoteSearchTrack[];
    streamingPage: { offset: number; limit: number; hasMore: boolean };
}

const likedRemoteSelect = {
    likedAt: true,
    trackYtMusic: {
        select: {
            id: true,
            videoId: true,
            title: true,
            artist: true,
            album: true,
            duration: true,
            thumbnailUrl: true,
            artistId: true,
            albumId: true,
        },
    },
    trackMusicSource: {
        select: {
            provider: true,
            providerTrackId: true,
            verifiedMetadata: true,
            metadataObservedAt: true,
            metadataConnectionVersion: true,
        },
    },
} satisfies Prisma.LikedRemoteTrackSelect;

/**
 * Searches only this owner's materialized external likes, without provider HTTP.
 * Filtering precedes database pagination; attestation validation then omits invalid
 * rows while hasMore describes the raw page so clients can advance past them.
 */
export async function searchLikedRemoteTracks({
    userId,
    query,
    offset,
    limit,
}: LikedRemoteSearchOptions): Promise<LikedRemoteSearchResult> {
    const streamingPage = { offset, limit, hasMore: false };
    if (!userId.trim() || !query.trim()) {
        return { streamingTracks: [], streamingPage };
    }

    const literalQuery = escapeLikePattern(query.trim());
    const contains = { contains: literalQuery, mode: "insensitive" as const };
    // Verified recording metadata accepts at most ten artist credits.
    const paths = [
        ["title"],
        ...Array.from({ length: 10 }, (_, index) => ["artists", String(index)]),
    ];
    const nativeMatches: Prisma.TrackMusicSourceWhereInput[] = paths.map(
        (path) => ({
            verifiedMetadata: {
                path,
                string_contains: literalQuery,
                mode: "insensitive",
            },
        }),
    );
    const rows = await prisma.likedRemoteTrack.findMany({
        where: {
            userId,
            OR: [
                {
                    trackYtMusic: {
                        OR: [
                            { title: contains },
                            { artist: contains },
                            { album: contains },
                        ],
                    },
                },
                {
                    trackMusicSource: {
                        provider: { in: ["vk", "yandex"] },
                        OR: nativeMatches,
                    },
                },
            ],
        },
        select: likedRemoteSelect,
        orderBy: [{ likedAt: "desc" }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
    });

    const streamingTracks: LikedRemoteSearchTrack[] = [];
    for (const row of rows.slice(0, limit)) {
        if (row.trackMusicSource) {
            const track = toVerifiedMusicSourceLikedTrack(
                row.trackMusicSource,
                row.likedAt,
            );
            if (track) streamingTracks.push(track);
        } else if (row.trackYtMusic) {
            streamingTracks.push(
                toLikedResponseTrack(
                    normalizeYtMusicTrack(row.trackYtMusic),
                    row.likedAt,
                ),
            );
        }
    }
    return {
        streamingTracks,
        streamingPage: { ...streamingPage, hasMore: rows.length > limit },
    };
}
