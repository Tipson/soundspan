import axios from "axios";
import { logger } from "../utils/logger";
import type { SpotifyPlaylist, SpotifyTrack } from "./spotifyTypes";

const HTML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
};

export interface SpotifyPlaylistEmbedSession {
    token: string;
    expiresAt: number;
}

/** Recovers the short-lived anonymous session shipped with a playlist embed. */
export async function fetchSpotifyPlaylistEmbedSession(
    playlistId: string,
): Promise<SpotifyPlaylistEmbedSession | null> {
    try {
        const response = await axios.get(
            `https://open.spotify.com/embed/playlist/${playlistId}`,
            {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    Accept: "text/html,application/xhtml+xml",
                    "Accept-Language": "en-US,en;q=0.9",
                },
                timeout: 10000,
            },
        );
        const html =
            typeof response.data === "string"
                ? response.data
                : String(response.data ?? "");
        const match = html.match(
            /<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/,
        );
        if (!match) return null;

        const payload = JSON.parse(match[1]) as {
            props?: {
                pageProps?: {
                    state?: {
                        settings?: {
                            session?: {
                                accessToken?: unknown;
                                accessTokenExpirationTimestampMs?: unknown;
                            };
                        };
                    };
                };
            };
        };
        const session = payload.props?.pageProps?.state?.settings?.session;
        const token = session?.accessToken;
        if (typeof token !== "string" || token.length === 0) return null;

        const now = Date.now();
        const declaredExpiry = Number(
            session?.accessTokenExpirationTimestampMs,
        );
        if (Number.isFinite(declaredExpiry) && declaredExpiry <= now + 60_000) {
            return null;
        }

        return {
            token,
            expiresAt: Number.isFinite(declaredExpiry)
                ? declaredExpiry
                : now + 30 * 60 * 1000,
        };
    } catch (error: unknown) {
        logger.debug("Spotify: Embed session token unavailable", error);
        return null;
    }
}

/** Decodes one layer of HTML entities used by Spotify embed markup. */
export function decodeSpotifyHtmlEntities(value: string): string {
    return value.replace(
        /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|quot|apos|lt|gt|nbsp));/g,
        (match, hex: string | undefined, dec: string | undefined, named) => {
            if (hex !== undefined) {
                return String.fromCharCode(Number.parseInt(hex, 16));
            }
            if (dec !== undefined) {
                return String.fromCharCode(Number.parseInt(dec, 10));
            }
            return HTML_NAMED_ENTITIES[named] ?? match;
        },
    );
}

function stripSpotifyHtmlContent(value: string): string {
    const withoutTags = value.replace(/<[^>]+>/g, " ");
    return decodeSpotifyHtmlEntities(withoutTags).replace(/\s+/g, " ").trim();
}

/** Parses an embed duration label into milliseconds. */
export function parseSpotifyDurationLabelToMs(label: string): number {
    const parts = label
        .trim()
        .split(":")
        .map((part) => Number.parseInt(part, 10));
    if (parts.some((part) => Number.isNaN(part) || part < 0)) {
        return 0;
    }

    if (parts.length === 2) {
        return (parts[0] * 60 + parts[1]) * 1000;
    }
    if (parts.length === 3) {
        return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    }
    return 0;
}

/** Parses the server-rendered fallback rows from a Spotify playlist embed. */
export function parseSpotifyEmbedTrackRows(
    playlistId: string,
    html: string,
): SpotifyPlaylist | null {
    const tracks: SpotifyTrack[] = [];
    const rowPattern =
        /<li[^>]*data-testid="tracklist-row-\d+"[^>]*>([\s\S]*?)<\/li>/g;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowPattern.exec(html)) !== null) {
        const rowContent = rowMatch[1];
        const titleMatch = rowContent.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
        const artistMatch = rowContent.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
        if (!titleMatch || !artistMatch) {
            continue;
        }

        const title = stripSpotifyHtmlContent(titleMatch[1]);
        const artistContent = artistMatch[1].replace(
            /^\s*<span[^>]*>[\s\S]*?<\/span>\s*/i,
            "",
        );
        const artist = stripSpotifyHtmlContent(artistContent);
        if (!title || !artist) {
            continue;
        }

        const durationMatch = rowContent.match(
            /data-testid="duration-cell"[^>]*>([^<]+)</i,
        );
        const durationMs = durationMatch
            ? parseSpotifyDurationLabelToMs(
                  decodeSpotifyHtmlEntities(durationMatch[1]),
              )
            : 0;

        const index = tracks.length;
        tracks.push({
            spotifyId: `${playlistId}:${index}`,
            title,
            artist,
            artistId: "",
            album: "Unknown Album",
            albumId: "",
            isrc: null,
            durationMs,
            trackNumber: index + 1,
            previewUrl: null,
            coverUrl: null,
        });
    }

    if (tracks.length === 0) {
        return null;
    }

    const metadataMatch = html.match(
        /<span[^>]*>([^<]+)<\/span>\s*<span[^>]*>\s*(?:·|&middot;|&#183;)\s*<\/span>\s*<span[^>]*>([^<]+)<\/span>/i,
    );
    const playlistName = metadataMatch
        ? stripSpotifyHtmlContent(metadataMatch[1])
        : "Unknown Playlist";
    const playlistOwner = metadataMatch
        ? stripSpotifyHtmlContent(metadataMatch[2])
        : "Unknown";
    const imageMatch = html.match(
        /--image-src:url\((?:&#x27;|&#39;|["'])?([^"')]+)(?:&#x27;|&#39;|["'])?\)/i,
    );
    const imageUrl = imageMatch
        ? decodeSpotifyHtmlEntities(imageMatch[1])
        : null;

    return {
        id: playlistId,
        name: playlistName || "Unknown Playlist",
        description: null,
        owner: playlistOwner || "Unknown",
        imageUrl,
        trackCount: tracks.length,
        tracks,
        isPublic: true,
    };
}
