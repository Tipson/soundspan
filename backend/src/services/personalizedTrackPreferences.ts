import { prisma } from "../utils/db";
import {
    buildPersonalizedRepeatExclusions,
    PERSONALIZED_LISTENING_LOOKBACK_MS,
    type PersonalizedRepeatExclusions,
} from "./personalizedRepeatPolicy";

/** Bounded, account-scoped actual listening, including manual plays without an exposure. */
export async function loadYouTubeRepeatExclusions(
    userId: string,
    now: Date,
): Promise<PersonalizedRepeatExclusions> {
    const rows = await prisma.play.findMany({
        where: {
            userId,
            trackYtMusicId: { not: null },
            playedAt: {
                gte: new Date(
                    now.getTime() - PERSONALIZED_LISTENING_LOOKBACK_MS,
                ),
                lte: now,
            },
        },
        orderBy: [{ playedAt: "desc" }, { id: "asc" }],
        take: 1_000,
        select: {
            playedAt: true,
            listenedSeconds: true,
            outcome: true,
            trackYtMusic: {
                select: { videoId: true, artist: true, title: true },
            },
        },
    });
    return buildPersonalizedRepeatExclusions(
        rows.flatMap((row) =>
            row.trackYtMusic
                ? [
                      {
                          track: row.trackYtMusic,
                          playedAt: row.playedAt,
                          listenedSeconds: row.listenedSeconds,
                          outcome: row.outcome,
                      },
                  ]
                : [],
        ),
        now,
    );
}

/** Already viewed, served identities must not consume a fresh reserve's slots. */
export async function loadRecentlyViewedCanonicalKeys(
    userId: string,
    canonicalKeys: readonly string[],
    now: Date,
): Promise<Set<string>> {
    const keys = [...new Set(canonicalKeys.filter(Boolean))];
    if (keys.length === 0) return new Set();
    const rows = await prisma.recommendationExposure.groupBy({
        by: ["canonicalKey"],
        where: {
            userId,
            canonicalKey: { in: keys },
            viewedAt: { gt: new Date(now.getTime() - 86_400_000) },
            generation: { served: true, userId },
        },
        orderBy: { canonicalKey: "asc" },
        take: keys.length,
    });
    return new Set(rows.map((row) => row.canonicalKey));
}

/** Exact active YouTube track dislikes for one account's candidate batch. */
export async function loadDislikedYouTubeIds(
    userId: string,
    videoIds: string[],
): Promise<Set<string>> {
    if (videoIds.length === 0) return new Set();
    const rows = await prisma.dislikedEntity.findMany({
        where: {
            userId,
            entityType: "track",
            entityId: { in: videoIds.map((id) => `yt:${id}`) },
        },
        select: { entityId: true },
    });
    return new Set(rows.map((row) => row.entityId.slice(3)));
}

/** Two distinct active dislikes suppress an artist for 30 days, like the Wave. */
export async function loadSuppressedYouTubeArtists(
    userId: string,
    now: Date = new Date(),
): Promise<Set<string>> {
    const rows = await prisma.dislikedEntity.findMany({
        where: {
            userId,
            entityType: "track",
            entityId: { startsWith: "yt:" },
            dislikedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
        },
        orderBy: { dislikedAt: "desc" },
        take: 100,
        select: { entityId: true },
    });
    const videoIds = [...new Set(rows.map((row) => row.entityId.slice(3)))];
    if (videoIds.length < 2) return new Set();
    const tracks = await prisma.trackYtMusic.findMany({
        where: { videoId: { in: videoIds } },
        select: { videoId: true, artist: true },
    });
    const videosByArtist = new Map<string, Set<string>>();
    for (const track of tracks) {
        const key = track.artist.trim().toLocaleLowerCase("en-US");
        if (!key || key === "unknown" || key === "unknown artist") continue;
        const videos = videosByArtist.get(key) ?? new Set<string>();
        videos.add(track.videoId);
        videosByArtist.set(key, videos);
    }
    return new Set(
        [...videosByArtist].flatMap(([key, videos]) =>
            videos.size >= 2 ? [key] : [],
        ),
    );
}
