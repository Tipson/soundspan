import { Router, type RequestHandler } from "express";
import type { CanonicalMediaSearchResult } from "@soundspan/media-metadata-contract";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { lastFmService } from "../services/lastfm";
import {
    searchService,
    normalizeCacheQuery,
    type SearchResults,
} from "../services/search";
import axios from "axios";
import { redisClient } from "../utils/redis";
import { z } from "zod";
import { LIBRARY_ORIGIN_VALUES } from "../utils/librarySorting";
import {
    ytMusicService,
    type YtMusicCatalogAlbumResult,
    type YtMusicCatalogArtistResult,
} from "../services/youtubeMusic";
import { searchYtMusicDiscoveryCatalog } from "../services/ytMusicDiscoveryCatalog";
import { getSystemSettings } from "../utils/systemSettings";
import { ytMusicSearchLimiter } from "../middleware/rateLimiter";
import {
    normalizeArtistName as normalizeCanonicalArtistName,
    normalizeForExactKey,
} from "../utils/artistNormalization";

const router = Router();

interface DiscoverTrackResult {
    type: "track";
    id?: string;
    name: string;
    artist?: string;
    album?: string | null;
    image?: string | null;
    providerTrackId?: string;
    streamSource?: "youtube";
    youtubeVideoId?: string;
    duration?: number | null;
    [key: string]: unknown;
}

interface DiscoverAlbumResult {
    type: "album";
    id: string;
    browseId: string;
    name: string;
    artist: string;
    image: string | null;
    year: string | null;
    provider: "ytmusic";
}

interface DiscoverArtistResult {
    type: "music";
    id: string;
    name: string;
    image: string | null;
    provider: "ytmusic";
    youtubeChannelId: string;
}

interface DiscoverYtMusicCatalogResult {
    tracks: DiscoverTrackResult[];
    albums: DiscoverAlbumResult[];
    artists: DiscoverArtistResult[];
    failedFilters: Array<"songs" | "albums" | "artists">;
}

function isDiscoverYtMusicCatalogResult(
    value: unknown,
): value is DiscoverYtMusicCatalogResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        Array.isArray(record.tracks) &&
        Array.isArray(record.albums) &&
        Array.isArray(record.artists) &&
        Array.isArray(record.failedFilters)
    );
}

const LONG_FORM_TRACK_SECONDS = 20 * 60;
const VIDEO_STYLE_TITLE_PATTERN =
    /\b(?:full album|full concert|live\s*stream|official live video)\b/i;
const YT_MUSIC_DISCOVERY_TIMEOUT_MS = 8_000;
const DISCOVERY_SOURCE_DEADLINE_MS = 9_000;
const DISCOVERY_CORRECTION_DEADLINE_MS = 1_500;

function withDiscoveryDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`${label} exceeded ${timeoutMs}ms deadline`));
        }, timeoutMs);
        promise.then(resolve, reject).finally(() => clearTimeout(timeout));
    });
}

const discoverMusicSearchLimiter: RequestHandler = (req, res, next) => {
    const requestedType =
        typeof req.query.type === "string" ? req.query.type : "music";
    if (requestedType !== "music" && requestedType !== "all") {
        next();
        return;
    }
    ytMusicSearchLimiter(req, res, next);
};

const searchQuerySchema = z.object({
    q: z.string().max(500).default(""),
    type: z
        .enum([
            "all",
            "artists",
            "albums",
            "tracks",
            "audiobooks",
            "podcasts",
            "episodes",
        ])
        .default("all"),
    genre: z.string().trim().min(1).max(120).optional(),
    limit: z.preprocess((value) => {
        const parsed = Number.parseInt(String(value ?? "20"), 10);
        return Number.isNaN(parsed) ? 20 : Math.min(Math.max(parsed, 1), 100);
    }, z.number().int()),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
    source: z.enum(LIBRARY_ORIGIN_VALUES).default("all"),
});

function normalizeDiscoverArtistName(value: unknown): string {
    return typeof value === "string" ? normalizeCanonicalArtistName(value) : "";
}

function normalizeDiscoverArtistTags(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
        .filter((tag): tag is string => tag.length > 0);
}

function normalizeDiscoverTrackIdentity(value: unknown): string {
    return typeof value === "string" ? normalizeForExactKey(value) : "";
}

function discoverTrackIdentity(track: DiscoverTrackResult): string | null {
    const artist = normalizeDiscoverTrackIdentity(track.artist);
    const title = normalizeDiscoverTrackIdentity(track.name);
    return artist && title ? `${artist}::${title}` : null;
}

function discoverTrackAlbumsMatch(
    first: DiscoverTrackResult,
    second: DiscoverTrackResult,
): boolean {
    const firstAlbum = normalizeDiscoverTrackIdentity(first.album);
    const secondAlbum = normalizeDiscoverTrackIdentity(second.album);
    return !firstAlbum || !secondAlbum || firstAlbum === secondAlbum;
}

function mapYtMusicDiscoverTrack(
    result: CanonicalMediaSearchResult,
): DiscoverTrackResult | null {
    const providerTrackId = result.providerTrackId.trim();
    const title = result.title.trim();
    const artist = result.artistName.trim();
    if (
        result.provider !== "ytmusic" ||
        result.source !== "youtube" ||
        !providerTrackId ||
        !title ||
        !artist
    ) {
        return null;
    }

    return {
        type: "track",
        id: providerTrackId,
        name: title,
        artist,
        album: result.albumTitle,
        image: result.thumbnailUrl,
        providerTrackId,
        streamSource: "youtube",
        youtubeVideoId: providerTrackId,
        duration: result.durationSec,
    };
}

function mapYtMusicDiscoverAlbum(
    result: YtMusicCatalogAlbumResult,
): DiscoverAlbumResult {
    return {
        type: "album",
        id: result.browseId,
        browseId: result.browseId,
        name: result.title,
        artist: result.artistName,
        image: result.thumbnailUrl,
        year: result.year,
        provider: "ytmusic",
    };
}

function mapYtMusicDiscoverArtist(
    result: YtMusicCatalogArtistResult,
): DiscoverArtistResult {
    return {
        type: "music",
        id: result.channelId,
        name: result.name,
        image: result.thumbnailUrl,
        provider: "ytmusic",
        youtubeChannelId: result.channelId,
    };
}

async function searchYtMusicDiscoverCatalog(
    query: string,
    limit: number,
): Promise<DiscoverYtMusicCatalogResult> {
    const response = await searchYtMusicDiscoveryCatalog(
        ytMusicService,
        "__public__",
        query,
        limit,
        { timeoutMs: YT_MUSIC_DISCOVERY_TIMEOUT_MS, maxRetries: 0 },
    );

    const tracks = response.tracks
        .slice(0, limit)
        .map(mapYtMusicDiscoverTrack)
        .filter((track): track is DiscoverTrackResult => track !== null);
    const seenBrowseIds = new Set<string>();
    const albums = response.albums.flatMap((result) => {
        if (
            result.mediaType !== "album" ||
            seenBrowseIds.has(result.browseId)
        ) {
            return [];
        }
        seenBrowseIds.add(result.browseId);
        return [mapYtMusicDiscoverAlbum(result)];
    });
    const seenChannelIds = new Set<string>();
    const artists = response.artists.flatMap((result) => {
        if (
            result.mediaType !== "artist" ||
            seenChannelIds.has(result.channelId)
        ) {
            return [];
        }
        seenChannelIds.add(result.channelId);
        return [mapYtMusicDiscoverArtist(result)];
    });

    return {
        tracks,
        albums,
        artists,
        failedFilters: response.failedFilters,
    };
}

function mergeDiscoverArtists(
    metadataArtists: any[],
    ytMusicArtists: DiscoverArtistResult[],
): any[] {
    const merged: any[] = [];
    const indexByName = new Map<string, number>();
    for (const artist of metadataArtists) {
        const name = normalizeDiscoverArtistName(artist?.name);
        const existingIndex = name ? indexByName.get(name) : undefined;
        if (existingIndex !== undefined) {
            const existing = merged[existingIndex];
            merged[existingIndex] = {
                ...artist,
                ...existing,
                image: existing.image || artist?.image,
                mbid: existing.mbid || artist?.mbid,
            };
            continue;
        }
        if (name) {
            indexByName.set(name, merged.length);
        }
        merged.push(artist);
    }

    for (const providerArtist of ytMusicArtists) {
        const name = normalizeDiscoverArtistName(providerArtist.name);
        const existingIndex = name ? indexByName.get(name) : undefined;
        if (existingIndex !== undefined) {
            const existing = merged[existingIndex];
            merged[existingIndex] = {
                ...existing,
                image: existing.image || providerArtist.image,
                provider: "ytmusic",
                youtubeChannelId: providerArtist.youtubeChannelId,
            };
            continue;
        }
        if (name) {
            indexByName.set(name, merged.length);
        }
        merged.push(providerArtist);
    }

    return merged;
}

function rankDiscoverTracks(
    tracks: DiscoverTrackResult[],
    query: string,
): DiscoverTrackResult[] {
    const queryKey = normalizeDiscoverTrackIdentity(query);
    return tracks
        .map((track, index) => {
            const artistKey = normalizeDiscoverTrackIdentity(track.artist);
            const titleKey = normalizeDiscoverTrackIdentity(track.name);
            const exactMatch =
                !!queryKey && (artistKey === queryKey || titleKey === queryKey);
            const containsQuery =
                !!queryKey &&
                (artistKey.includes(queryKey) || titleKey.includes(queryKey));
            const likelyLongForm =
                (typeof track.duration === "number" &&
                    track.duration >= LONG_FORM_TRACK_SECONDS) ||
                VIDEO_STYLE_TITLE_PATTERN.test(track.name);
            const directlyPlayable = Boolean(track.youtubeVideoId);
            return {
                track,
                index,
                likelyLongForm,
                exactMatch,
                containsQuery,
                directlyPlayable,
            };
        })
        .sort(
            (first, second) =>
                Number(first.likelyLongForm) - Number(second.likelyLongForm) ||
                Number(second.exactMatch) - Number(first.exactMatch) ||
                Number(second.containsQuery) - Number(first.containsQuery) ||
                Number(second.directlyPlayable) -
                    Number(first.directlyPlayable) ||
                first.index - second.index,
        )
        .map(({ track }) => track);
}

function mergeDiscoverTracks(
    lastFmTracks: DiscoverTrackResult[],
    ytMusicTracks: DiscoverTrackResult[],
): DiscoverTrackResult[] {
    const merged: DiscoverTrackResult[] = [];
    const indexesByIdentity = new Map<string, number[]>();
    const seenProviderIds = new Set<string>();

    for (const track of lastFmTracks) {
        const identity = discoverTrackIdentity(track);
        const existingIndex = identity
            ? indexesByIdentity
                  .get(identity)
                  ?.find((index) =>
                      discoverTrackAlbumsMatch(merged[index], track),
                  )
            : undefined;
        if (existingIndex !== undefined) {
            const existing = merged[existingIndex];
            merged[existingIndex] = {
                ...track,
                ...existing,
                image: existing.image || track.image,
                album: existing.album || track.album,
            };
            continue;
        }

        if (identity) {
            const indexes = indexesByIdentity.get(identity) || [];
            indexes.push(merged.length);
            indexesByIdentity.set(identity, indexes);
        }
        if (typeof track.youtubeVideoId === "string") {
            seenProviderIds.add(track.youtubeVideoId);
        }
        merged.push(track);
    }

    for (const ytTrack of ytMusicTracks) {
        const providerId = ytTrack.youtubeVideoId;
        if (
            typeof providerId !== "string" ||
            !providerId ||
            seenProviderIds.has(providerId)
        ) {
            continue;
        }
        seenProviderIds.add(providerId);

        const identity = discoverTrackIdentity(ytTrack);
        const existingIndex = identity
            ? indexesByIdentity
                  .get(identity)
                  ?.find((index) =>
                      discoverTrackAlbumsMatch(merged[index], ytTrack),
                  )
            : undefined;
        if (existingIndex !== undefined) {
            const existing = merged[existingIndex];
            if (existing.youtubeVideoId) {
                continue;
            }
            merged[existingIndex] = {
                ...existing,
                album: existing.album || ytTrack.album,
                image: existing.image || ytTrack.image,
                providerTrackId: ytTrack.providerTrackId,
                streamSource: "youtube",
                youtubeVideoId: providerId,
                duration: ytTrack.duration,
            };
            continue;
        }

        if (identity) {
            const indexes = indexesByIdentity.get(identity) || [];
            indexes.push(merged.length);
            indexesByIdentity.set(identity, indexes);
        }
        merged.push(ytTrack);
    }

    return merged;
}

async function getLocalSimilarArtistsFromGraph(
    artistName: string,
    artistMbid: string,
    limit: number,
): Promise<any[]> {
    const normalizedArtistName = normalizeDiscoverArtistName(artistName);
    const seedFilters: any[] = [
        { name: { equals: artistName, mode: "insensitive" } },
    ];

    if (normalizedArtistName) {
        seedFilters.push({ normalizedName: normalizedArtistName });
    }

    if (artistMbid) {
        seedFilters.push({ mbid: artistMbid });
    }

    const seedArtist = await prisma.artist.findFirst({
        where: {
            OR: seedFilters,
        },
        select: { id: true },
    });

    if (!seedArtist) {
        return [];
    }

    const graphSimilar = await prisma.similarArtist.findMany({
        where: { fromArtistId: seedArtist.id },
        orderBy: { weight: "desc" },
        take: limit,
        include: {
            toArtist: {
                select: {
                    id: true,
                    mbid: true,
                    name: true,
                    heroUrl: true,
                    summary: true,
                    genres: true,
                },
            },
        },
    });

    const seen = new Set<string>();
    const mapped: any[] = [];
    for (const relation of graphSimilar) {
        const target = relation.toArtist;
        const dedupeKey =
            target.mbid ||
            target.id ||
            normalizeDiscoverArtistName(target.name);
        if (!target.name || !dedupeKey || seen.has(dedupeKey)) {
            continue;
        }

        seen.add(dedupeKey);
        mapped.push({
            type: "music",
            id: target.mbid || target.id,
            name: target.name,
            listeners: 0,
            url: null,
            image: target.heroUrl || null,
            mbid: target.mbid,
            bio: target.summary || null,
            tags: normalizeDiscoverArtistTags(target.genres),
        });
    }

    return mapped;
}

async function filterLibraryArtistsFromDiscoverResults(
    artists: any[],
): Promise<any[]> {
    if (artists.length === 0) {
        return artists;
    }

    const candidateNames = Array.from(
        new Set(
            artists
                .map((artist) =>
                    typeof artist?.name === "string" ? artist.name.trim() : "",
                )
                .filter(Boolean),
        ),
    );

    if (candidateNames.length === 0) {
        return artists;
    }

    const candidateNormalizedNames = Array.from(
        new Set(
            candidateNames.map(normalizeDiscoverArtistName).filter(Boolean),
        ),
    );

    const libraryArtists = await prisma.artist.findMany({
        where: {
            OR: [
                ...candidateNames.map((name) => ({
                    name: { equals: name, mode: "insensitive" as const },
                })),
                ...(candidateNormalizedNames.length > 0
                    ? [
                          {
                              normalizedName: {
                                  in: candidateNormalizedNames,
                              },
                          },
                      ]
                    : []),
            ],
        },
        select: { name: true, normalizedName: true },
    });

    if (libraryArtists.length === 0) {
        return artists;
    }

    const libraryArtistNames = new Set(
        libraryArtists.map((artist) =>
            artist.normalizedName
                ? normalizeDiscoverArtistName(artist.normalizedName)
                : normalizeDiscoverArtistName(artist.name),
        ),
    );

    return artists.filter(
        (artist) =>
            !libraryArtistNames.has(normalizeDiscoverArtistName(artist?.name)),
    );
}

function transformSearchResults(serviceResults: SearchResults) {
    return {
        artists: serviceResults.artists,
        albums: serviceResults.albums.map((album) => ({
            id: album.id,
            title: album.title,
            artistId: album.artistId,
            year: album.year,
            coverUrl: album.coverUrl,
            source: album.source,
            peer: album.peer,
            artist: {
                id: album.artistId,
                name: album.artistName,
                mbid: "",
            },
        })),
        tracks: serviceResults.tracks.map((track) => ({
            id: track.id,
            title: track.title,
            albumId: track.albumId,
            duration: track.duration,
            trackNo: 0,
            loudnessLufs: track.loudnessLufs ?? null,
            truePeakDb: track.truePeakDb ?? null,
            source: track.source,
            peer: track.peer,
            album: {
                id: track.albumId,
                title: track.albumTitle,
                artistId: track.artistId,
                coverUrl: null,
                albumLoudnessLufs: track.albumLoudnessLufs ?? null,
                albumTruePeakDb: track.albumTruePeakDb ?? null,
                artist: {
                    id: track.artistId,
                    name: track.artistName,
                    mbid: "",
                },
            },
        })),
        audiobooks: serviceResults.audiobooks,
        podcasts: serviceResults.podcasts,
        episodes: serviceResults.episodes,
    };
}

router.use(requireAuth);

/**
 * @openapi
 * /api/search:
 *   get:
 *     summary: Search across your music library
 *     description: Search for artists, albums, tracks, audiobooks, and podcasts in your library using PostgreSQL full-text search
 *     tags: [Search]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         required: true
 *         description: Search query
 *         example: "radiohead"
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [all, artists, albums, tracks, audiobooks, podcasts, episodes]
 *         description: Type of content to search
 *         default: all
 *       - in: query
 *         name: genre
 *         schema:
 *           type: string
 *         description: Filter tracks by genre
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [all, local, peers]
 *           default: all
 *         description: Limit music results by owning source
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Maximum number of results per type
 *         default: 20
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           maximum: 10000
 *           default: 0
 *         description: Zero-based result offset for type-scoped searches; ignored when type is all
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Artist'
 *                 albums:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Album'
 *                 tracks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Track'
 *                 audiobooks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 podcasts:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/", async (req, res) => {
    try {
        const parsed = searchQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json({ error: "Invalid search query" });
        }
        const { type, genre, offset, source } = parsed.data;
        const query = parsed.data.q.trim();
        const searchLimit = parsed.data.limit;
        const sourceOption = req.query.source === undefined ? {} : { source };

        if (!query) {
            return res.json({
                artists: [],
                albums: [],
                tracks: [],
                audiobooks: [],
                podcasts: [],
                episodes: [],
            });
        }

        // Delegate to service (handles caching + parallel execution + genre filtering)
        if (type === "all") {
            const serviceResults = await searchService.searchAll({
                query,
                limit: searchLimit,
                genre: genre as string | undefined,
                ...sourceOption,
            });

            return res.json(transformSearchResults(serviceResults));
        }

        // Single-type search (service handles caching)
        const serviceResults = await searchService.searchByType({
            query,
            type: type as string,
            limit: searchLimit,
            offset,
            genre: genre as string | undefined,
            ...sourceOption,
        });

        res.json(transformSearchResults(serviceResults));
    } catch (error) {
        logger.error("Search error:", error);
        res.status(500).json({ error: "Search failed" });
    }
});

/**
 * @openapi
 * /api/search/genres:
 *   get:
 *     summary: Get all genres with track counts
 *     tags: [Search]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of genres with track counts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   name:
 *                     type: string
 *                   trackCount:
 *                     type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /search/genres
router.get("/genres", async (req, res) => {
    try {
        const genres = await prisma.genre.findMany({
            where: {
                OR: [
                    { trackGenres: { none: {} } },
                    {
                        trackGenres: {
                            some: { track: { removedAt: null } },
                        },
                    },
                ],
            },
            orderBy: { name: "asc" },
            include: {
                _count: {
                    select: {
                        trackGenres: {
                            where: { track: { removedAt: null } },
                        },
                    },
                },
            },
        });

        res.json(
            genres.map((g) => ({
                id: g.id,
                name: g.name,
                trackCount: g._count.trackGenres,
            })),
        );
    } catch (error) {
        logger.error("Get genres error:", error);
        res.status(500).json({ error: "Failed to get genres" });
    }
});

/**
 * @openapi
 * /api/search/discover:
 *   get:
 *     summary: Search for new content to discover (not in your library)
 *     description: Searches Last.fm metadata and the enabled public YouTube Music catalog, merging exact provider identities into playable track results.
 *     tags: [Search]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Search query
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [music, podcasts, all]
 *           default: music
 *         description: Type of content to discover
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 50
 *         description: Maximum number of results
 *     responses:
 *       200:
 *         description: Discovery search results with optional alias info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                 aliasInfo:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     original:
 *                       type: string
 *                     canonical:
 *                       type: string
 *                     mbid:
 *                       type: string
 *       401:
 *         description: Not authenticated
 */
router.get("/discover", discoverMusicSearchLimiter, async (req, res) => {
    try {
        const { q = "", type = "music", limit = "20" } = req.query;

        const query = (q as string).trim();
        const parsedLimit = parseInt(limit as string, 10);
        const searchLimit = Number.isNaN(parsedLimit)
            ? 20
            : Math.min(Math.max(parsedLimit, 1), 50);

        if (!query) {
            return res.json({ results: [], aliasInfo: null });
        }

        let ytMusicEnabled = false;
        let lastFmEnabled = false;
        if (type === "music" || type === "all") {
            try {
                const settings = await getSystemSettings();
                ytMusicEnabled = Boolean(settings?.ytMusicEnabled);
            } catch (settingsError) {
                logger.warn(
                    "[SEARCH DISCOVER] YouTube Music settings check failed:",
                    settingsError,
                );
            }
            try {
                lastFmEnabled = await lastFmService.isConfigured();
            } catch (lastFmSettingsError) {
                logger.warn(
                    "[SEARCH DISCOVER] Last.fm settings check failed:",
                    lastFmSettingsError,
                );
            }
        }

        // Cache TTL: 15 min (900s) -- external API data rarely changes
        const cacheKey = `search:discover:v5:yt${ytMusicEnabled ? "1" : "0"}:lf${lastFmEnabled ? "1" : "0"}:${type}:${normalizeCacheQuery(query)}:${searchLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(
                    `[SEARCH DISCOVER] Cache hit for query="${query}" type=${type}`,
                );
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            logger.warn("[SEARCH DISCOVER] Redis read error:", err);
        }

        const results: any[] = [];

        // Resolve alias (sequential -- modifies the search query, cached 30 days)
        let searchQuery = query;
        let aliasInfo: {
            original: string;
            canonical: string;
            mbid?: string;
        } | null = null;

        if ((type === "music" || type === "all") && lastFmEnabled) {
            try {
                const correction = await withDiscoveryDeadline(
                    lastFmService.getArtistCorrection(query),
                    DISCOVERY_CORRECTION_DEADLINE_MS,
                    "Last.fm correction",
                );
                if (correction?.corrected) {
                    searchQuery = correction.canonicalName;
                    aliasInfo = {
                        original: query,
                        canonical: correction.canonicalName,
                        mbid: correction.mbid,
                    };
                    logger.debug(
                        `[SEARCH DISCOVER] Alias resolved: "${query}" -> "${correction.canonicalName}"`,
                    );
                }
            } catch (correctionError) {
                logger.warn(
                    "[SEARCH DISCOVER] Correction check failed:",
                    correctionError,
                );
            }
        }

        // Build parallel promises for independent external calls
        const promiseMap: Record<string, Promise<any>> = {};

        if (type === "music" || type === "all") {
            if (lastFmEnabled) {
                promiseMap.artists = withDiscoveryDeadline(
                    lastFmService.searchArtists(searchQuery, searchLimit),
                    DISCOVERY_SOURCE_DEADLINE_MS,
                    "Last.fm artist search",
                );
                promiseMap.tracks = withDiscoveryDeadline(
                    lastFmService.searchTracks(searchQuery, searchLimit),
                    DISCOVERY_SOURCE_DEADLINE_MS,
                    "Last.fm track search",
                );
            }
            if (ytMusicEnabled) {
                promiseMap.ytMusicCatalog = withDiscoveryDeadline(
                    searchYtMusicDiscoverCatalog(searchQuery, searchLimit),
                    DISCOVERY_SOURCE_DEADLINE_MS,
                    "YouTube Music discovery batch",
                );
            }
        }

        if (type === "podcasts" || type === "all") {
            promiseMap.podcasts = axios
                .get("https://itunes.apple.com/search", {
                    params: {
                        term: query,
                        media: "podcast",
                        entity: "podcast",
                        limit: searchLimit,
                    },
                    timeout: 5000,
                })
                .then((resp) =>
                    resp.data.results.map((podcast: any) => ({
                        type: "podcast",
                        id: podcast.collectionId,
                        name: podcast.collectionName,
                        artist: podcast.artistName,
                        description: podcast.description,
                        coverUrl:
                            podcast.artworkUrl600 || podcast.artworkUrl100,
                        feedUrl: podcast.feedUrl,
                        genres: podcast.genres || [],
                        trackCount: podcast.trackCount,
                    })),
                );
        }

        // Await all with allSettled so one failure doesn't block others
        const keys = Object.keys(promiseMap);
        const settled = await Promise.allSettled(
            keys.map((k) => promiseMap[k]),
        );
        const resolved: Record<string, any[]> = {};
        let externalSearchFailed = false;
        keys.forEach((k, i) => {
            const result = settled[i];
            if (result.status === "fulfilled") {
                resolved[k] = result.value;
            } else {
                externalSearchFailed = true;
                logger.error(
                    `[SEARCH DISCOVER] ${k} search failed:`,
                    result.reason,
                );
                resolved[k] = [];
            }
        });

        const ytMusicCatalog = isDiscoverYtMusicCatalogResult(
            resolved.ytMusicCatalog,
        )
            ? resolved.ytMusicCatalog
            : undefined;
        const ytMusicTracks = ytMusicCatalog?.tracks ?? [];
        const ytMusicAlbums = ytMusicCatalog?.albums ?? [];
        const ytMusicArtists = ytMusicCatalog?.artists ?? [];
        if (ytMusicCatalog?.failedFilters.length) {
            externalSearchFailed = true;
            logger.warn(
                `[SEARCH DISCOVER] YouTube Music batch returned partial categories: ${ytMusicCatalog.failedFilters.join(", ")}`,
            );
        }

        if (resolved.artists || ytMusicArtists.length > 0) {
            const mergedArtists = mergeDiscoverArtists(
                resolved.artists || [],
                ytMusicArtists,
            );
            logger.debug(
                `[SEARCH DISCOVER] Found ${mergedArtists.length} merged artist results`,
            );
            const filteredArtists =
                await filterLibraryArtistsFromDiscoverResults(mergedArtists);
            logger.debug(
                `[SEARCH DISCOVER] Filtered to ${filteredArtists.length} new artists not already in library`,
            );
            results.push(...filteredArtists);
        }
        if (resolved.tracks || ytMusicTracks.length > 0) {
            const mergedTracks = mergeDiscoverTracks(
                resolved.tracks || [],
                ytMusicTracks,
            );
            logger.debug(
                `[SEARCH DISCOVER] Found ${mergedTracks.length} merged track results`,
            );
            results.push(...rankDiscoverTracks(mergedTracks, searchQuery));
        }
        if (ytMusicAlbums.length > 0) {
            results.push(...ytMusicAlbums);
        }
        if (resolved.podcasts) {
            results.push(...resolved.podcasts);
        }

        const payload = { results, aliasInfo };

        // A partial response is useful for this request, but caching it would
        // hide the missing catalog source for the full 15-minute TTL.
        if (!externalSearchFailed) {
            try {
                await redisClient.setEx(cacheKey, 900, JSON.stringify(payload));
            } catch (err) {
                logger.warn("[SEARCH DISCOVER] Redis write error:", err);
            }
        }

        res.json(payload);
    } catch (error) {
        logger.error("Discovery search error:", error);
        res.status(500).json({ error: "Discovery search failed" });
    }
});

/**
 * @openapi
 * /api/search/discover/similar:
 *   get:
 *     summary: Fetch musically similar artists via Last.fm
 *     tags: [Search]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: artist
 *         required: true
 *         schema:
 *           type: string
 *         description: Artist name
 *       - in: query
 *         name: mbid
 *         schema:
 *           type: string
 *         description: MusicBrainz artist ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 6
 *           maximum: 50
 *         description: Maximum number of similar artists
 *     responses:
 *       200:
 *         description: Similar artists list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 similarArtists:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 */
router.get("/discover/similar", async (req, res) => {
    try {
        const { artist = "", mbid = "", limit = "6" } = req.query;
        const artistName = (artist as string).trim();
        const artistMbid = (mbid as string).trim();
        const parsedLimit = parseInt(limit as string, 10);
        const similarLimit = Number.isNaN(parsedLimit)
            ? 6
            : Math.min(Math.max(parsedLimit, 1), 50);
        const seedLimit = Math.min(100, Math.max(10, similarLimit * 3));

        if (!artistName) {
            return res.json({ similarArtists: [] });
        }

        const cacheKey = `search:discover:similar:${normalizeCacheQuery(artistName)}:${artistMbid}:${similarLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(
                    `[SEARCH SIMILAR] Cache hit for artist="${artistName}"`,
                );
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            logger.warn("[SEARCH SIMILAR] Redis read error:", err);
        }

        const similar = await lastFmService.getSimilarArtists(
            artistMbid,
            artistName,
            seedLimit,
        );
        let similarArtists =
            similar.length > 0
                ? await lastFmService.enrichSimilarArtists(
                      similar,
                      similarLimit,
                  )
                : [];

        if (similarArtists.length === 0) {
            logger.debug(
                `[SEARCH SIMILAR] Last.fm returned no enriched artists for artist="${artistName}", falling back to local graph`,
            );
            try {
                similarArtists = await getLocalSimilarArtistsFromGraph(
                    artistName,
                    artistMbid,
                    similarLimit,
                );
            } catch (fallbackError) {
                logger.warn(
                    "[SEARCH SIMILAR] Local fallback query error:",
                    fallbackError,
                );
            }
        }

        const payload = { similarArtists };

        try {
            // Cache TTL: 1 hour (3600s) -- similar artists rarely change
            await redisClient.setEx(cacheKey, 3600, JSON.stringify(payload));
        } catch (err) {
            logger.warn("[SEARCH SIMILAR] Redis write error:", err);
        }

        res.json(payload);
    } catch (error) {
        logger.error("Similar artists search error:", error);
        res.status(500).json({ error: "Similar artists search failed" });
    }
});

export default router;
