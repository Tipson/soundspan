/**
 * PlaylistImportService — Multi-provider playlist import.
 *
 * Resolves tracks: local library first → YT Music (universal fallback).
 * Creates PlaylistItems with appropriate
 * provider FKs.
 */

import type { ResolvedMediaSource } from "@soundspan/media-metadata-contract";
import { prisma } from "../utils/db";
import { TRACK_VISIBLE_WHERE } from "../utils/librarySorting";
import type { ImportDraftEntry } from "./importDraftParser";
import type { ImportDraftMatch } from "./importDraftSnapshot";
import { logger } from "../utils/logger";
import { decrypt } from "../utils/encryption";
import { getSystemSettings } from "../utils/systemSettings";
import { spotifyService } from "./spotify";
import { deezerService } from "./deezer";
import {
    fetchYandexPlaylistForImport,
    parseYandexPlaylistUrl,
} from "./yandexPlaylistImport";
import { ytMusicService } from "./youtubeMusic";
import { trackMappingService } from "./trackMappingService";
import {
    buildM3UMatchIndex,
    matchM3UEntryAgainstLibrary,
    matchTrackAgainstLibrary,
    type LocalTrackCandidate,
} from "../utils/trackMatching";
import { parseM3U } from "./m3uParser";
import { remoteProviderAdapters } from "./remoteProviders/adapters";
import { buildGenericImportPlaylistMixId } from "./genericImportIdentity";
import { canonicalIdentityResolver } from "./recommendations/canonicalIdentity";
import { persistImportedProviderIdentity } from "./recommendations/durableIdentityPersistence";

const log = logger.child("PlaylistImportService");
const MATCH_BATCH_SIZE = 25;
const MATCH_BATCH_CONCURRENCY = 2;
const UPSERT_CONCURRENCY = 6;
const MAPPING_CREATE_CONCURRENCY = 8;
const REMOTE_IMPORT_QUALITY = "HIGH";
const IDEMPOTENT_PLAYLIST_TRANSACTION_ATTEMPTS = 2;

interface PlaylistImportOptions {
    idempotencyKey?: string;
}

export type PlaylistImportProgressStage = "source" | "local" | "youtube";

export interface PlaylistImportProgressEvent {
    stage: PlaylistImportProgressStage;
    completed: number;
    total: number;
}

export interface PlaylistImportPreviewOptions {
    onProgress?: (event: PlaylistImportProgressEvent) => void | Promise<void>;
    onResolved?: (tracks: ResolvedTrack[]) => void | Promise<void>;
    onPrepared?: (prepared: PlaylistImportPreparedData) => void | Promise<void>;
}

function isPlaylistIdentityConflict(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const candidate = error as {
        code?: unknown;
        meta?: { modelName?: unknown; target?: unknown };
    };
    if (candidate.code !== "P2002") return false;
    if (
        candidate.meta?.modelName !== undefined &&
        candidate.meta.modelName !== "Playlist"
    ) {
        return false;
    }

    const target = candidate.meta?.target;
    if (Array.isArray(target)) {
        return target.includes("userId") && target.includes("mixId");
    }
    if (typeof target === "string") {
        const normalized = target.toLowerCase();
        return normalized.includes("userid") && normalized.includes("mixid");
    }
    return false;
}

function parseProviderUrlCandidate(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl);
    } catch {
        const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl);
        if (hasExplicitScheme) {
            return null;
        }
        try {
            return new URL(`https://${rawUrl}`);
        } catch {
            return null;
        }
    }
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
    if (values.length === 0) return [];
    const size = Math.max(1, chunkSize);
    const chunks: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
        chunks.push(values.slice(i, i + size));
    }
    return chunks;
}

async function mapWithConcurrency<T, R>(
    values: T[],
    concurrency: number,
    worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (values.length === 0) return [];

    const results = new Array<R>(values.length);
    const limit = Math.max(1, Math.min(concurrency, values.length));
    let cursor = 0;

    async function runWorker() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= values.length) return;
            results[index] = await worker(values[index], index);
        }
    }

    await Promise.all(Array.from({ length: limit }, () => runWorker()));
    return results;
}

export interface ImportTrackMeta {
    artist: string;
    title: string;
    album?: string;
    duration?: number;
    isrc?: string;
    /** YT Music native playlist track videoId */
    videoId?: string;
    /** Tidal native playlist track ID */
    tidalId?: number;
}

export interface ResolvedTrack {
    index: number;
    artist: string;
    title: string;
    album?: string;
    duration?: number;
    isrc?: string;
    videoId?: string;
    tidalId?: number;
    /** Local library track ID, if matched */
    trackId?: string;
    /** TrackYtMusic record ID, if resolved */
    trackYtMusicId?: string;
    /** TrackTidal record ID, if resolved */
    trackTidalId?: string;
    /** Resolution source */
    source: ResolvedMediaSource | "unresolved";
    /** Match confidence (0-100) */
    confidence: number;
}

export interface PlaylistImportSummary {
    total: number;
    local: number;
    youtube: number;
    tidal: number;
    unresolved: number;
}

export interface PlaylistImportPreparedData {
    playlistName: string;
    resolved: ResolvedTrack[];
    summary: PlaylistImportSummary;
}

type SourceType = "spotify" | "deezer" | "youtube" | "yandex";
type ProviderMatchInput = {
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
    isrc?: string;
};
type IndexedImportTrack = { index: number; track: ImportTrackMeta };

class PlaylistImportService {
    /** Match an untrusted upload without writing provider namespaces or account data. */
    async matchDraftTracks(
        entries: ImportDraftEntry[],
        options: { check?: () => Promise<void> } = {},
    ): Promise<ImportDraftMatch[]> {
        const check = options.check ?? (async () => {});
        await check();
        const candidates = (await this.getLocalLibraryCandidates()).filter(
            (track) => track.filePath !== "",
        );
        await check();
        const result: ImportDraftMatch[] = entries.map(() => ({
            source: "unresolved",
            confidence: 0,
        }));
        const pending: Array<{ index: number; entry: ImportDraftEntry }> = [];
        const metadata = new Map<string, Promise<ImportDraftMatch | null>>();
        let unavailable = false;
        const song = (
            videoId: string,
            confidence: number,
        ): Promise<ImportDraftMatch | null> => {
            let cached = metadata.get(videoId);
            if (!cached) {
                cached = (async () => {
                    await check();
                    let found;
                    try {
                        found = await ytMusicService.getSong(
                            "__public__",
                            videoId,
                        );
                    } catch {
                        await check();
                        return null;
                    }
                    await check();
                    if (
                        found.videoId !== videoId ||
                        typeof found.title !== "string" ||
                        !found.title.trim() ||
                        found.title.length > 300 ||
                        typeof found.artist !== "string" ||
                        !found.artist.trim() ||
                        found.artist.length > 300 ||
                        (found.album !== undefined &&
                            (typeof found.album !== "string" ||
                                found.album.length > 300)) ||
                        (found.duration !== undefined &&
                            (!Number.isFinite(found.duration) ||
                                found.duration < 0 ||
                                found.duration > 86400))
                    )
                        return null;
                    return {
                        source: "youtube",
                        videoId,
                        confidence: 100,
                        title: found.title,
                        artist: found.artist,
                        album: found.album ?? "",
                        duration: Math.floor(found.duration ?? 0),
                    };
                })();
                metadata.set(videoId, cached);
            }
            return cached.then((match) =>
                match ? { ...match, confidence } : null,
            );
        };
        for (const [index, entry] of entries.entries()) {
            if (entry.sourceRef?.source === "library") {
                const exact = candidates.find(
                    (candidate) => candidate.id === entry.sourceRef!.entityId,
                );
                if (exact)
                    result[index] = {
                        source: "local",
                        trackId: exact.id,
                        confidence: 100,
                    };
            } else if (entry.sourceRef?.source === "youtube")
                pending.push({ index, entry });
            else if (entry.artist) {
                const matched = matchTrackAgainstLibrary(
                    {
                        artist: entry.artist,
                        title: entry.title,
                        ...(entry.album ? { album: entry.album } : {}),
                    },
                    candidates,
                );
                if (matched && matched.matchConfidence >= 70)
                    result[index] = {
                        source: "local",
                        trackId: matched.trackId,
                        confidence: matched.matchConfidence,
                    };
                else pending.push({ index, entry });
            }
        }
        await mapWithConcurrency(
            chunkArray(pending, MATCH_BATCH_SIZE),
            MATCH_BATCH_CONCURRENCY,
            async (batch) => {
                await check();
                if (unavailable) return;
                const fuzzy = batch.filter(
                    (item) => item.entry.sourceRef?.source !== "youtube",
                );
                let matches: Array<{
                    videoId: string;
                    title: string;
                    duration: number;
                } | null> = [];
                if (fuzzy.length) {
                    try {
                        matches = await ytMusicService.findMatchesForAlbum(
                            "__public__",
                            fuzzy.map(({ entry }) => ({
                                artist: entry.artist,
                                title: entry.title,
                                ...(entry.album
                                    ? { albumTitle: entry.album }
                                    : {}),
                            })),
                        );
                    } catch {
                        unavailable = true;
                    }
                    await check();
                }
                const byIndex = new Map(
                    fuzzy.map((item, index) => [item.index, matches[index]]),
                );
                await mapWithConcurrency(batch, 4, async (item) => {
                    const exact =
                        item.entry.sourceRef?.source === "youtube"
                            ? item.entry.sourceRef.entityId
                            : null;
                    const videoId = exact ?? byIndex.get(item.index)?.videoId;
                    if (!videoId || !/^[A-Za-z0-9_-]{1,64}$/.test(videoId))
                        return;
                    const matched = await song(videoId, exact ? 100 : 85);
                    if (matched) result[item.index] = matched;
                });
            },
        );
        await check();
        return result;
    }

    /**
     * Parse a playlist URL and detect the source type.
     */
    parseSourceUrl(url: string): { source: SourceType; id: string } | null {
        const normalizedUrl = url.trim();
        const parsedUrl = parseProviderUrlCandidate(normalizedUrl);
        const host =
            parsedUrl?.hostname.toLowerCase().replace(/^www\./, "") ?? "";
        const pathSegments = (parsedUrl?.pathname ?? "")
            .split("/")
            .filter(Boolean);

        const yandexId = parsedUrl && parseYandexPlaylistUrl(parsedUrl);
        if (yandexId) return { source: "yandex", id: yandexId };

        // Spotify
        const isSpotifyUri = normalizedUrl.toLowerCase().startsWith("spotify:");
        const spotifyParsed =
            isSpotifyUri ||
            host === "spotify.com" ||
            host === "open.spotify.com" ||
            host === "play.spotify.com"
                ? spotifyService.parseUrl(normalizedUrl)
                : null;
        if (spotifyParsed && spotifyParsed.type === "playlist") {
            return { source: "spotify", id: spotifyParsed.id };
        }

        // Deezer
        if (host === "deezer.com") {
            const playlistIdx = pathSegments.findIndex(
                (segment) => segment.toLowerCase() === "playlist",
            );
            const deezerId =
                playlistIdx >= 0 && playlistIdx < pathSegments.length - 1
                    ? pathSegments[playlistIdx + 1]
                    : null;
            if (deezerId && /^\d+$/.test(deezerId)) {
                return { source: "deezer", id: deezerId };
            }
        }

        // YouTube / YouTube Music — use URL parsing for robust query-param extraction
        if (
            (host === "music.youtube.com" ||
                host === "youtube.com" ||
                host === "m.youtube.com") &&
            parsedUrl?.pathname.replace(/\/+$/, "") === "/playlist"
        ) {
            const listId = parsedUrl.searchParams.get("list");
            if (listId && /^[A-Za-z0-9_-]+$/.test(listId)) {
                return { source: "youtube", id: listId };
            }
        }

        return null;
    }

    /**
     * Fetch track metadata from the source URL.
     */
    async fetchSourceTracks(
        source: SourceType,
        sourceId: string,
        userId?: string,
    ): Promise<{ name: string; tracks: ImportTrackMeta[] }> {
        if (source === "yandex") return fetchYandexPlaylistForImport(sourceId);
        if (source === "spotify") {
            const playlist =
                await spotifyService.getPlaylistForImport(sourceId);
            if (!playlist) throw new Error("Spotify playlist not found");

            return {
                name: playlist.name,
                tracks: playlist.tracks.map((t) => ({
                    artist: t.artist || "Unknown",
                    title: t.title || "Unknown",
                    album: t.album || undefined,
                    duration: t.durationMs
                        ? Math.round(t.durationMs / 1000)
                        : undefined,
                    isrc: t.isrc || undefined,
                })),
            };
        }

        if (source === "deezer") {
            const playlist = await deezerService.getPlaylist(sourceId);
            if (!playlist) throw new Error("Deezer playlist not found");

            return {
                name: playlist.title,
                tracks: playlist.tracks.map((t) => ({
                    artist: t.artist || "Unknown",
                    title: t.title || "Unknown",
                    album: t.album || undefined,
                    duration: t.durationMs
                        ? Math.round(t.durationMs / 1000)
                        : undefined,
                })),
            };
        }

        if (source === "youtube") {
            const ytBrowseUserId =
                userId && (await this.checkYtMusicAuth(userId))
                    ? userId
                    : "__public__";
            return remoteProviderAdapters.youtube.fetchPlaylist({
                sourceId,
                userId: ytBrowseUserId,
                authenticated: ytBrowseUserId !== "__public__",
                quality: REMOTE_IMPORT_QUALITY,
            });
        }

        throw new Error(`Unsupported source: ${source}`);
    }

    /**
     * Resolve a single track against available providers.
     * Priority: local library → YT Music.
     */
    async resolveTrack(
        trackMeta: ImportTrackMeta,
        localCandidates: LocalTrackCandidate[],
        _userId: string,
        _retiredTidalAuth = false,
    ): Promise<Omit<ResolvedTrack, "index">> {
        const base = {
            artist: trackMeta.artist,
            title: trackMeta.title,
            album: trackMeta.album,
        };

        // 1. Try local library match
        const localMatch = matchTrackAgainstLibrary(trackMeta, localCandidates);
        if (localMatch && localMatch.matchConfidence >= 70) {
            return {
                ...base,
                trackId: localMatch.trackId,
                source: "local",
                confidence: localMatch.matchConfidence,
            };
        }

        // 2. Try YT Music (unauthenticated, universal fallback)
        try {
            const providerInput = this.toProviderMatchInput(trackMeta);
            const [ytMatch] = await ytMusicService.findMatchesForAlbum(
                "__public__",
                [providerInput],
            );
            if (ytMatch) {
                const ytRow = await trackMappingService.upsertTrackYtMusic({
                    videoId: ytMatch.videoId,
                    title: ytMatch.title,
                    artist: trackMeta.artist,
                    album: trackMeta.album || "",
                    duration: ytMatch.duration,
                });
                return {
                    ...base,
                    trackYtMusicId: ytRow.id,
                    source: "youtube",
                    confidence: 85,
                };
            }
        } catch (err) {
            log.warn("YT Music match failed during import:", err);
        }

        return { ...base, source: "unresolved", confidence: 0 };
    }

    /**
     * Fetches complete source metadata without waiting for provider matching.
     */
    async prepareImport(
        userId: string,
        sourceUrl: string,
    ): Promise<PlaylistImportPreparedData> {
        const parsed = this.parseSourceUrl(sourceUrl);
        if (!parsed) throw new Error("Unsupported playlist URL");

        const { name, tracks } = await this.fetchSourceTracks(
            parsed.source,
            parsed.id,
            userId,
        );
        const resolved = tracks.map((track, index) => ({
            index,
            artist: track.artist,
            title: track.title,
            ...(track.album ? { album: track.album } : {}),
            ...(track.duration !== undefined
                ? { duration: track.duration }
                : {}),
            ...(track.isrc ? { isrc: track.isrc } : {}),
            ...(track.videoId ? { videoId: track.videoId } : {}),
            ...(track.tidalId !== undefined ? { tidalId: track.tidalId } : {}),
            source: "unresolved" as const,
            confidence: 0,
        }));
        return {
            playlistName: name,
            resolved,
            summary: {
                total: resolved.length,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: resolved.length,
            },
        };
    }

    /**
     * Resolves a prepared source snapshot against available providers.
     */
    async resolvePreparedImport(
        userId: string,
        prepared: PlaylistImportPreparedData,
        options: PlaylistImportPreviewOptions = {},
    ): Promise<PlaylistImportPreparedData> {
        const tracks: ImportTrackMeta[] = prepared.resolved.map((track) => ({
            artist: track.artist,
            title: track.title,
            album: track.album,
            duration: track.duration,
            isrc: track.isrc,
            videoId: track.videoId,
            tidalId: track.tidalId,
        }));

        // Fetch local library for matching
        const localCandidates = await this.getLocalLibraryCandidates();

        const resolved = await this.resolveTracks(
            tracks,
            localCandidates,
            options.onProgress,
            options.onResolved,
            prepared.resolved,
        );

        const summary = {
            total: resolved.length,
            local: resolved.filter((r) => r.source === "local").length,
            youtube: resolved.filter((r) => r.source === "youtube").length,
            tidal: 0,
            unresolved: resolved.filter((r) => r.source === "unresolved")
                .length,
        };

        return { playlistName: prepared.playlistName, resolved, summary };
    }

    /**
     * Preview import — resolves all tracks but doesn't create playlist.
     */
    async previewImport(
        userId: string,
        sourceUrl: string,
        options: PlaylistImportPreviewOptions = {},
    ): Promise<PlaylistImportPreparedData> {
        const prepared = await this.prepareImport(userId, sourceUrl);
        await options.onPrepared?.(prepared);
        await options.onProgress?.({
            stage: "source",
            completed: prepared.summary.total,
            total: prepared.summary.total,
        });
        return this.resolvePreparedImport(userId, prepared, options);
    }

    /**
     * Preview import for a local M3U or M3U8 playlist file.
     * Resolves only against the local library using deterministic tiered matching.
     */
    async previewM3UImport(
        playlistName: string,
        content: string,
    ): Promise<{
        playlistName: string;
        resolved: ResolvedTrack[];
        summary: {
            total: number;
            local: number;
            youtube: number;
            tidal: number;
            unresolved: number;
        };
    }> {
        const entries = parseM3U(content);
        const localCandidates = await this.getLocalLibraryCandidates();
        const matchIndex = buildM3UMatchIndex(localCandidates);

        const resolved = entries.map((entry, index) => {
            const match = matchM3UEntryAgainstLibrary(entry, matchIndex);
            return {
                index,
                artist: entry.artist || "",
                title: entry.title || getFallbackTitleFromPath(entry.filePath),
                ...(match
                    ? {
                          trackId: match.trackId,
                          source: "local" as const,
                          confidence: match.matchConfidence,
                      }
                    : {
                          source: "unresolved" as const,
                          confidence: 0,
                      }),
            };
        });

        return {
            playlistName,
            resolved,
            summary: {
                total: resolved.length,
                local: resolved.filter((track) => track.source === "local")
                    .length,
                youtube: 0,
                tidal: 0,
                unresolved: resolved.filter(
                    (track) => track.source === "unresolved",
                ).length,
            },
        };
    }

    /**
     * Execute import — creates Playlist + PlaylistItems from preview data.
     * Accepts pre-resolved preview data directly to avoid re-fetching. A supplied
     * idempotency key reuses an owner-scoped playlist across durable job retries.
     */
    async importPlaylist(
        userId: string,
        previewData: {
            playlistName: string;
            resolved: ResolvedTrack[];
            summary: {
                total: number;
                local: number;
                youtube: number;
                tidal: number;
                unresolved: number;
            };
        },
        overrideName?: string,
        options: PlaylistImportOptions = {},
    ): Promise<{
        playlistId: string;
        summary: {
            total: number;
            local: number;
            youtube: number;
            tidal: number;
            unresolved: number;
        };
    }> {
        const effectivePlaylistName = overrideName || previewData.playlistName;
        const importMixId =
            options.idempotencyKey === undefined
                ? null
                : buildGenericImportPlaylistMixId(options.idempotencyKey);
        const importableTracks = this.buildImportableTracks(
            previewData.resolved,
        );

        await this.validateResolvedTrackIds(importableTracks);

        const persistPlaylist = () =>
            prisma.$transaction(async (tx) => {
                if (importMixId) {
                    const existingPlaylist = await tx.playlist.findUnique({
                        where: {
                            userId_mixId: { userId, mixId: importMixId },
                        },
                        select: { id: true },
                    });
                    if (existingPlaylist) return existingPlaylist;
                }

                const createdPlaylist = await tx.playlist.create({
                    data: {
                        userId,
                        name: effectivePlaylistName,
                        ...(importMixId ? { mixId: importMixId } : {}),
                    },
                });

                const items = importableTracks.map((r, sort) => ({
                    playlistId: createdPlaylist.id,
                    trackId: r.trackId || null,
                    trackTidalId: null,
                    trackYtMusicId: r.trackYtMusicId || null,
                    sort,
                }));

                if (items.length > 0) {
                    const createdItems = await tx.playlistItem.createMany({
                        data: items,
                    });
                    if (createdItems.count !== items.length) {
                        throw new Error(
                            "Playlist import item persistence was incomplete",
                        );
                    }
                }

                return createdPlaylist;
            });

        let playlist: { id: string } | null = null;
        const transactionAttempts = importMixId
            ? IDEMPOTENT_PLAYLIST_TRANSACTION_ATTEMPTS
            : 1;
        for (let attempt = 1; attempt <= transactionAttempts; attempt += 1) {
            try {
                playlist = await persistPlaylist();
                break;
            } catch (error) {
                const canRetryUniqueRace =
                    importMixId !== null &&
                    isPlaylistIdentityConflict(error) &&
                    attempt < transactionAttempts;
                if (!canRetryUniqueRace) throw error;
            }
        }
        if (!playlist) {
            throw new Error("Playlist import transaction did not complete");
        }

        await mapWithConcurrency(
            importableTracks,
            MAPPING_CREATE_CONCURRENCY,
            async (resolvedTrack) => {
                try {
                    await trackMappingService.createMapping({
                        trackId: resolvedTrack.trackId,
                        trackYtMusicId: resolvedTrack.trackYtMusicId,
                        confidence: resolvedTrack.confidence / 100,
                        source: "import-match",
                    });
                    const providerIdentity =
                        resolvedTrack.source === "youtube" &&
                        resolvedTrack.videoId
                            ? {
                                  source: "youtube" as const,
                                  providerTrackId: resolvedTrack.videoId,
                              }
                            : resolvedTrack.source === "local" &&
                                resolvedTrack.trackId
                              ? {
                                    source: "library" as const,
                                    providerTrackId: resolvedTrack.trackId,
                                }
                              : null;
                    if (resolvedTrack.isrc && providerIdentity) {
                        const providerTrack = {
                            ...providerIdentity,
                            title: resolvedTrack.title,
                            artist: resolvedTrack.artist,
                            album: resolvedTrack.album,
                            duration: resolvedTrack.duration,
                            isrc: resolvedTrack.isrc,
                        };
                        const canonical =
                            await canonicalIdentityResolver.resolveProviderTrack(
                                providerTrack,
                            );
                        await persistImportedProviderIdentity(
                            providerTrack,
                            canonical,
                        );
                    }
                } catch (err) {
                    log.warn(
                        "Track mapping creation failed after import:",
                        err,
                    );
                }
            },
        );

        log.info(
            `Imported playlist "${effectivePlaylistName}" for user ${userId}: ` +
                `${previewData.summary.total} tracks (${previewData.summary.local} local, ` +
                `${previewData.summary.youtube} YouTube Music, ` +
                `${previewData.summary.unresolved} unresolved)`,
        );

        return {
            playlistId: playlist.id,
            summary: previewData.summary,
        };
    }

    /**
     * Finds the playlist committed for one durable import job and owner.
     */
    async findImportedPlaylistId(
        userId: string,
        idempotencyKey: string,
    ): Promise<string | null> {
        const playlist = await prisma.playlist.findUnique({
            where: {
                userId_mixId: {
                    userId,
                    mixId: buildGenericImportPlaylistMixId(idempotencyKey),
                },
            },
            select: { id: true },
        });
        return playlist?.id ?? null;
    }

    /**
     * Validates that all track IDs referenced in resolved tracks exist in the database.
     */
    private async validateResolvedTrackIds(
        tracks: ResolvedTrack[],
    ): Promise<void> {
        const trackIds = [
            ...new Set(tracks.filter((t) => t.trackId).map((t) => t.trackId!)),
        ];
        const ytIds = [
            ...new Set(
                tracks
                    .filter((t) => t.trackYtMusicId)
                    .map((t) => t.trackYtMusicId!),
            ),
        ];
        const missing: string[] = [];

        if (trackIds.length > 0) {
            const found = await prisma.track.findMany({
                where: { ...TRACK_VISIBLE_WHERE, id: { in: trackIds } },
                select: { id: true },
            });
            const foundSet = new Set(found.map((r) => r.id));
            for (const id of trackIds) {
                if (!foundSet.has(id)) missing.push(`trackId:${id}`);
            }
        }

        if (ytIds.length > 0) {
            const found = await prisma.trackYtMusic.findMany({
                where: { id: { in: ytIds } },
                select: { id: true },
            });
            const foundSet = new Set(found.map((r) => r.id));
            for (const id of ytIds) {
                if (!foundSet.has(id)) missing.push(`trackYtMusicId:${id}`);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `Invalid track reference(s): ${missing.join(", ")}`,
            );
        }
    }

    private toProviderMatchInput(
        trackMeta: ImportTrackMeta,
    ): ProviderMatchInput {
        return {
            artist: trackMeta.artist,
            title: trackMeta.title,
            albumTitle: trackMeta.album,
            duration: trackMeta.duration,
            isrc: trackMeta.isrc,
        };
    }

    private buildImportableTracks(
        resolvedTracks: ResolvedTrack[],
    ): ResolvedTrack[] {
        return resolvedTracks.filter(
            (resolved) =>
                resolved.source === "local" || resolved.source === "youtube",
        );
    }

    private async resolveTracks(
        tracks: ImportTrackMeta[],
        localCandidates: LocalTrackCandidate[],
        onProgress?: PlaylistImportPreviewOptions["onProgress"],
        onResolved?: PlaylistImportPreviewOptions["onResolved"],
        initialResolved?: ResolvedTrack[],
    ): Promise<ResolvedTrack[]> {
        const resolved: ResolvedTrack[] = initialResolved
            ? initialResolved.map((track) =>
                  track.source === "tidal"
                      ? {
                            ...track,
                            tidalId: undefined,
                            trackTidalId: undefined,
                            source: "unresolved",
                            confidence: 0,
                        }
                      : { ...track },
              )
            : tracks.map((track, index) => ({
                  index,
                  artist: track.artist,
                  title: track.title,
                  album: track.album,
                  duration: track.duration,
                  isrc: track.isrc,
                  videoId: track.videoId,
                  tidalId: track.tidalId,
                  source: "unresolved",
                  confidence: 0,
              }));
        const unresolved: IndexedImportTrack[] = [];
        const locallyResolved: ResolvedTrack[] = [];

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (resolved[i]?.source !== "unresolved") {
                continue;
            }
            const localMatch = matchTrackAgainstLibrary(track, localCandidates);
            if (localMatch && localMatch.matchConfidence >= 70) {
                resolved[i] = {
                    ...resolved[i],
                    trackId: localMatch.trackId,
                    source: "local",
                    confidence: localMatch.matchConfidence,
                };
                locallyResolved.push(resolved[i]);
                continue;
            }

            unresolved.push({ index: i, track });
        }
        if (locallyResolved.length > 0) {
            await onResolved?.(locallyResolved);
        }
        await onProgress?.({
            stage: "local",
            completed: tracks.length,
            total: tracks.length,
        });

        // Resolve tracks that already have native YouTube provider IDs.
        const nativeResolved = await this.resolveNativeProviderTracks(
            unresolved,
            resolved,
        );
        if (nativeResolved.length > 0) {
            await onResolved?.(nativeResolved);
        }

        // Filter down to tracks still unresolved after native resolution
        const stillUnresolved = unresolved.filter(
            (item) => resolved[item.index].source === "unresolved",
        );

        await this.resolveWithYouTube(
            stillUnresolved,
            resolved,
            onProgress,
            onResolved,
        );

        return resolved;
    }

    private async resolveWithYouTube(
        unresolved: IndexedImportTrack[],
        resolved: ResolvedTrack[],
        onProgress?: PlaylistImportPreviewOptions["onProgress"],
        onResolved?: PlaylistImportPreviewOptions["onResolved"],
    ): Promise<void> {
        if (unresolved.length === 0) return;
        const batches = chunkArray(unresolved, MATCH_BATCH_SIZE);
        let completed = 0;
        await mapWithConcurrency(
            batches,
            MATCH_BATCH_CONCURRENCY,
            async (batch) => {
                let newlyResolved: ResolvedTrack[] = [];
                try {
                    try {
                        const matches =
                            await ytMusicService.findMatchesForAlbum(
                                "__public__",
                                batch.map(({ track }) =>
                                    this.toProviderMatchInput(track),
                                ),
                            );
                        const matchedTracks = batch.flatMap((item, index) => {
                            const match = matches[index];
                            return match ? [{ ...item, match }] : [];
                        });
                        const ytRows = await mapWithConcurrency(
                            matchedTracks,
                            UPSERT_CONCURRENCY,
                            async ({ track, match, index }) => {
                                try {
                                    const row =
                                        await trackMappingService.upsertTrackYtMusic(
                                            {
                                                videoId: match.videoId,
                                                title: match.title,
                                                artist: track.artist,
                                                album: track.album || "",
                                                duration: match.duration,
                                            },
                                        );
                                    return {
                                        index,
                                        trackYtMusicId: row.id,
                                        videoId: match.videoId,
                                    };
                                } catch (err) {
                                    log.warn(
                                        "YT Music upsert failed during import:",
                                        err,
                                    );
                                    return null;
                                }
                            },
                        );
                        newlyResolved = ytRows.flatMap((ytRow) => {
                            if (!ytRow) return [];
                            const current = resolved[ytRow.index];
                            resolved[ytRow.index] = {
                                ...current,
                                trackYtMusicId: ytRow.trackYtMusicId,
                                videoId: ytRow.videoId,
                                source: "youtube",
                                confidence: 85,
                            };
                            return [resolved[ytRow.index]];
                        });
                    } catch (err) {
                        log.warn(
                            "YT Music batch match failed during import:",
                            err,
                        );
                    }
                    if (newlyResolved.length > 0) {
                        await onResolved?.(newlyResolved);
                    }
                } finally {
                    completed += batch.length;
                    await onProgress?.({
                        stage: "youtube",
                        completed,
                        total: unresolved.length,
                    });
                }
            },
        );
    }

    private async resolveNativeProviderTracks(
        unresolved: IndexedImportTrack[],
        resolved: ResolvedTrack[],
    ): Promise<ResolvedTrack[]> {
        const nativeTracks = unresolved.filter((item) => !!item.track.videoId);
        if (nativeTracks.length === 0) return [];

        const resolvedNative = await mapWithConcurrency(
            nativeTracks,
            UPSERT_CONCURRENCY,
            async ({ index, track }) => {
                try {
                    if (track.videoId) {
                        const ytRow =
                            await trackMappingService.upsertTrackYtMusic({
                                videoId: track.videoId,
                                title: track.title,
                                artist: track.artist,
                                album: track.album || "",
                                duration: track.duration || 0,
                            });
                        resolved[index] = {
                            ...resolved[index],
                            trackYtMusicId: ytRow.id,
                            source: "youtube",
                            confidence: 100,
                        };
                    }
                    return resolved[index];
                } catch (err) {
                    log.warn(
                        "Native provider upsert failed during import:",
                        err,
                    );
                    return null;
                }
            },
        );
        return resolvedNative.filter(
            (track): track is ResolvedTrack => track !== null,
        );
    }

    private async getLocalLibraryCandidates(): Promise<LocalTrackCandidate[]> {
        const tracks = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                filePath: { not: null },
                origin: "LOCAL",
            },
            select: {
                id: true,
                title: true,
                duration: true,
                filePath: true,
                album: {
                    select: {
                        title: true,
                        artist: { select: { name: true } },
                    },
                },
            },
        });

        return tracks.flatMap((track) =>
            track.filePath === null
                ? []
                : [
                      {
                          id: track.id,
                          title: track.title,
                          duration: track.duration,
                          albumTitle: track.album.title,
                          artistName: track.album.artist.name,
                          filePath: track.filePath,
                      },
                  ],
        );
    }

    private async checkYtMusicAuth(userId: string): Promise<boolean> {
        try {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
                select: { ytMusicOAuthJson: true },
            });
            if (!settings?.ytMusicOAuthJson) {
                return false;
            }

            let oauthJson = settings.ytMusicOAuthJson;
            try {
                oauthJson = decrypt(settings.ytMusicOAuthJson);
            } catch {
                // keep plaintext legacy payloads compatible
            }

            const systemSettings = await getSystemSettings();
            await ytMusicService.restoreOAuthWithCredentials(
                userId,
                oauthJson,
                systemSettings?.ytMusicClientId || undefined,
                systemSettings?.ytMusicClientSecret || undefined,
            );
            return true;
        } catch (error) {
            log.warn(
                `[PlaylistImport] YT Music credentials restore failed for ${userId}; falling back to public browse`,
                error,
            );
            return false;
        }
    }
}

function getFallbackTitleFromPath(filePath: string): string {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const filename = normalizedPath.split("/").pop() || filePath;
    return filename.replace(/\.[^.]+$/, "");
}

export const playlistImportService = new PlaylistImportService();
