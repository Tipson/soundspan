import { prisma } from "../../utils/db";
import type { Readable } from "node:stream";
import type { ResolvedSource } from "../listenTogetherResolution";
import type {
    UnifiedPlaylistItemRecord,
    UnifiedTrackTidalRecord,
    UnifiedTrackYtMusicRecord,
} from "../unifiedTrackResponse";
import type {
    MappingProvider,
    RemoteProvider,
    StreamingProvider,
} from "./types";

/**
 * Playback, playlist-import, and playlist-row dispatch for remote providers.
 * Metadata fallback ladders remain owned by services/metadata and are not
 * wrapped here. Remaining dispatch sites migrate to this table as they are
 * touched.
 */

/** Remote row materialized for a playlist item. */
export type RemoteProviderTrackRecord =
    | UnifiedTrackTidalRecord
    | UnifiedTrackYtMusicRecord;

/** Common stream request accepted by each provider adapter. */
export interface RemoteProviderStreamInput {
    userId: string;
    quality: string;
    range?: string;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    /** Listener lifetime; disconnects cancel cold acquisition and active audio. */
    signal?: AbortSignal;
}

/** Stream response fields consumed by the HTTP proxy. */
export interface RemoteProviderStreamResponse {
    status: number;
    headers: Record<string, unknown>;
    data: Readable;
}

/** Common playlist request accepted by each provider adapter. */
export interface RemoteProviderPlaylistInput {
    sourceId: string;
    userId?: string;
    authenticated: boolean;
    quality: string;
}

/** Provider playlist track normalized for the import pipeline. */
export interface RemoteProviderPlaylistTrack {
    artist: string;
    title: string;
    album?: string;
    duration?: number;
    isrc?: string;
    videoId?: string;
    tidalId?: number;
}

/** Provider playlist normalized for the import pipeline. */
export interface RemoteProviderPlaylist {
    name: string;
    tracks: RemoteProviderPlaylistTrack[];
}

/** Shared playback, playlist-import, and playlist-row provider dispatch. */
export interface RemoteProviderAdapter {
    provider: RemoteProvider;
    mappingProvider: MappingProvider;
    streamingProvider: StreamingProvider;
    streamTrack(
        input: RemoteProviderStreamInput,
    ): Promise<RemoteProviderStreamResponse | null>;
    fetchPlaylist(
        input: RemoteProviderPlaylistInput,
    ): Promise<RemoteProviderPlaylist>;
    itemTrackId(item: UnifiedPlaylistItemRecord): string | null;
    itemTrack(
        item: UnifiedPlaylistItemRecord,
    ): RemoteProviderTrackRecord | null;
    resolvedTrackId(resolved: ResolvedSource): string | null;
    findTracksByIds(ids: string[]): Promise<RemoteProviderTrackRecord[]>;
    applyTrack(
        item: UnifiedPlaylistItemRecord,
        trackId: string,
        track: RemoteProviderTrackRecord,
    ): UnifiedPlaylistItemRecord;
}

function requireYoutubeVideoId(input: RemoteProviderStreamInput): string {
    const videoId = input.youtubeVideoId?.trim();
    if (!videoId) throw new Error("YouTube stream requires youtubeVideoId");
    return videoId;
}

function requireTidalTrack(
    track: RemoteProviderTrackRecord,
): UnifiedTrackTidalRecord {
    if (!("tidalId" in track)) {
        throw new Error("Tidal adapter requires a Tidal track row");
    }
    return track;
}

function requireYoutubeTrack(
    track: RemoteProviderTrackRecord,
): UnifiedTrackYtMusicRecord {
    if (!("videoId" in track)) {
        throw new Error("YouTube adapter requires a YouTube Music track row");
    }
    return track;
}

const tidalAdapter: RemoteProviderAdapter = {
    provider: "tidal",
    mappingProvider: "tidal",
    streamingProvider: "tidal",
    async streamTrack() {
        return null;
    },
    async fetchPlaylist() {
        throw new Error("TIDAL provider has been retired");
    },
    itemTrackId: (item) => item.trackTidalId,
    itemTrack: (item) => item.trackTidal,
    resolvedTrackId: (resolved) =>
        resolved.available && resolved.source === "tidal"
            ? resolved.trackTidalId
            : null,
    findTracksByIds: (ids) =>
        prisma.trackTidal.findMany({ where: { id: { in: ids } } }),
    applyTrack: (item, trackId, track) => ({
        ...item,
        trackId: null,
        trackTidalId: trackId,
        trackYtMusicId: null,
        track: null,
        trackTidal: requireTidalTrack(track),
        trackYtMusic: null,
    }),
};

const youtubeAdapter: RemoteProviderAdapter = {
    provider: "youtube",
    mappingProvider: "youtube",
    streamingProvider: "ytmusic",
    async streamTrack(input) {
        const { ytMusicService } = await import("../youtubeMusic");
        if (input.signal) {
            return ytMusicService.getStreamProxy(
                input.userId,
                requireYoutubeVideoId(input),
                input.quality,
                input.range,
                { signal: input.signal },
            );
        }
        return ytMusicService.getStreamProxy(
            input.userId,
            requireYoutubeVideoId(input),
            input.quality,
            input.range,
        );
    },
    async fetchPlaylist(input) {
        const { ytMusicService } = await import("../youtubeMusic");
        const playlist = await ytMusicService.getBrowsePlaylist(
            input.sourceId,
            100,
            input.userId ?? "__public__",
        );
        return {
            name: playlist.title,
            tracks: playlist.tracks.map((track) => ({
                artist: track.artist || "Unknown",
                title: track.title || "Unknown",
                album: track.album || undefined,
                duration: track.duration,
                videoId: track.videoId,
            })),
        };
    },
    itemTrackId: (item) => item.trackYtMusicId,
    itemTrack: (item) => item.trackYtMusic,
    resolvedTrackId: (resolved) =>
        resolved.available && resolved.source === "youtube"
            ? resolved.trackYtMusicId
            : null,
    findTracksByIds: (ids) =>
        prisma.trackYtMusic.findMany({ where: { id: { in: ids } } }),
    applyTrack: (item, trackId, track) => ({
        ...item,
        trackId: null,
        trackTidalId: null,
        trackYtMusicId: trackId,
        track: null,
        trackTidal: null,
        trackYtMusic: requireYoutubeTrack(track),
    }),
};

/** Stable provider iteration order used by routing code. */
export const REMOTE_PROVIDERS = [
    "tidal",
    "youtube",
] as const satisfies readonly RemoteProvider[];

/** Total adapter table keyed by canonical remote-provider identity. */
export const remoteProviderAdapters: Readonly<
    Record<RemoteProvider, RemoteProviderAdapter>
> = {
    tidal: tidalAdapter,
    youtube: youtubeAdapter,
};
