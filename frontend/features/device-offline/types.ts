import type {
    FederatedTrackPeer,
    RemoteMediaSource,
    UnifiedTrackSource,
} from "@soundspan/media-metadata-contract";

/** Portable metadata required to render and replay one downloaded track. */
export interface DeviceOfflineTrack {
    id: string;
    title: string;
    artist: { id?: string; name: string };
    album: {
        id?: string;
        title: string;
        coverArt?: string | null;
        albumLoudnessLufs?: number | null;
        albumTruePeakDb?: number | null;
    };
    duration: number;
    filePath?: string;
    source?: UnifiedTrackSource;
    peer?: FederatedTrackPeer;
    streamSource?: "local" | RemoteMediaSource;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    youtubeAudioFormat?: "mp4" | "webm";
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
}

export type DeviceOfflineDownloadStatus =
    | "downloading"
    | "ready"
    | "interrupted"
    | "error";

export type DeviceOfflineTransferMode = "foreground" | "background";

/** IndexedDB record for one user, track identity, and requested quality. */
export interface DeviceOfflineDownloadRecord {
    key: string;
    ownerId: string;
    trackIdentity: string;
    quality: string;
    virtualUrl: string;
    sourceUrl: string;
    track: DeviceOfflineTrack;
    status: DeviceOfflineDownloadStatus;
    transferMode: DeviceOfflineTransferMode;
    backgroundFetchId: string | null;
    /** Optional for backward compatibility with records created before leases. */
    foregroundLeaseId?: string | null;
    /** Wall-clock expiry renewed by the tab performing a foreground transfer. */
    foregroundLeaseExpiresAt?: number | null;
    bytesReceived: number;
    totalBytes: number | null;
    contentType: string | null;
    persistenceGranted: boolean | null;
    attempt: number;
    createdAt: number;
    updatedAt: number;
    errorCode: string | null;
    errorMessage: string | null;
}

export interface DeviceOfflineDownloadInput {
    ownerId: string;
    track: DeviceOfflineTrack;
    quality?: string;
    sourceUrl: string;
}
