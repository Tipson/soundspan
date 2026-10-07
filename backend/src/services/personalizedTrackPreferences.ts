import { prisma } from "../utils/db";

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
): Promise<Set<string>> {
    const rows = await prisma.dislikedEntity.findMany({
        where: {
            userId,
            entityType: "track",
            entityId: { startsWith: "yt:" },
            dislikedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
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
