import type {
    YtMusicArtistResponse,
    YtMusicThumbnail,
} from "@/lib/api/ytmusic";
import type { DiscoverResult } from "@/features/search/types";
import type { Artist, Track } from "./types";

interface NormalizeYtMusicArtistOptions {
    channelId: string;
    fallbackName: string;
}

export interface NormalizedYtMusicArtist {
    artist: Artist;
    providerAlbums: DiscoverResult[];
}

const nonEmptyString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
};

const bestThumbnailUrl = (
    thumbnails: YtMusicThumbnail[] | null | undefined,
): string | null => {
    if (!Array.isArray(thumbnails)) return null;

    return (
        thumbnails.reduce<{ url: string; score: number } | null>(
            (best, thumbnail) => {
                const url = nonEmptyString(thumbnail?.url);
                if (!url) return best;
                const width =
                    typeof thumbnail.width === "number" && thumbnail.width > 0
                        ? thumbnail.width
                        : 0;
                const height =
                    typeof thumbnail.height === "number" && thumbnail.height > 0
                        ? thumbnail.height
                        : width;
                const score = width * Math.max(height, 1);
                return !best || score >= best.score ? { url, score } : best;
            },
            null,
        )?.url ?? null
    );
};

export const parseYtMusicDuration = (value: unknown): number => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return Math.round(value);
    }
    if (typeof value !== "string") return 0;
    const parts = value
        .trim()
        .split(":")
        .map((part) => Number(part));
    if (
        parts.length < 1 ||
        parts.length > 3 ||
        parts.some(
            (part, index) =>
                !Number.isInteger(part) || part < 0 || (index > 0 && part > 59),
        )
    ) {
        return 0;
    }
    return parts.reduce((total, part) => total * 60 + part, 0);
};

export const normalizeYtMusicChannelId = (
    value: string | null | undefined,
): string | null => {
    const normalized = nonEmptyString(value);
    if (!normalized || !/^[A-Za-z0-9_-]{3,128}$/.test(normalized)) {
        return null;
    }
    return normalized;
};

export const normalizeYtMusicArtist = (
    payload: YtMusicArtistResponse,
    options: NormalizeYtMusicArtistOptions,
): NormalizedYtMusicArtist => {
    const channelId =
        normalizeYtMusicChannelId(payload.channelId) ?? options.channelId;
    const artistId = `ytartist:${channelId}`;
    const name =
        nonEmptyString(payload.name) ??
        nonEmptyString(options.fallbackName) ??
        "YouTube Music artist";
    const artistImage = bestThumbnailUrl(payload.thumbnails);

    const topTracks: Track[] = (payload.songs ?? []).flatMap((song) => {
        const videoId = nonEmptyString(song?.videoId);
        const title = nonEmptyString(song?.title);
        if (!videoId || !title) return [];

        return [
            {
                id: `yt:${videoId}`,
                title,
                duration: parseYtMusicDuration(song.duration),
                artist: {
                    id: artistId,
                    name: nonEmptyString(song.artist) ?? name,
                },
                album: {
                    title: nonEmptyString(song.album) ?? "YouTube Music",
                    coverArt: artistImage,
                },
                streamSource: "youtube" as const,
                youtubeVideoId: videoId,
                source: "youtube" as const,
            },
        ];
    });

    const providerAlbums: DiscoverResult[] = (payload.albums ?? []).flatMap(
        (album) => {
            const browseId = nonEmptyString(album?.browseId);
            const title = nonEmptyString(album?.title);
            if (!browseId || !title) return [];
            const year =
                typeof album.year === "number" && Number.isFinite(album.year)
                    ? String(Math.trunc(album.year))
                    : nonEmptyString(album.year);

            return [
                {
                    type: "album" as const,
                    id: browseId,
                    browseId,
                    name: title,
                    artist: name,
                    image: bestThumbnailUrl(album.thumbnails) ?? undefined,
                    year,
                    provider: "ytmusic" as const,
                },
            ];
        },
    );

    return {
        artist: {
            id: artistId,
            name,
            image: artistImage ?? undefined,
            bio: nonEmptyString(payload.description) ?? undefined,
            topTracks,
            albums: [],
            source: "youtube",
        },
        providerAlbums,
    };
};
