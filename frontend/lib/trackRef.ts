import type {
    CanonicalMediaSource,
    UnifiedTrackSource,
} from "@soundspan/media-metadata-contract";
import type { Track as AudioTrack } from "@/lib/audio-state-context";

export type TrackRef =
    | { trackId: string }
    | { tidalTrackId: number }
    | { youtubeVideoId: string };

export type AddToPlaylistRef =
    | { trackId: string }
    | {
          tidalTrackId: number;
          title: string;
          artist: string;
          album: string;
          duration: number;
          isrc?: string;
      }
    | {
          youtubeVideoId: string;
          title: string;
          artist: string;
          album: string;
          duration: number;
          thumbnailUrl?: string;
      };

type ProviderSource = CanonicalMediaSource;

type TrackRefInput = {
    id?: string | null;
    hasLocalFile?: boolean;
    filePath?: string | null;
    mediaSource?: ProviderSource | null;
    source?: UnifiedTrackSource | CanonicalMediaSource | null;
    title?: string | null;
    displayTitle?: string | null;
    duration?: number | string | null;
    isrc?: string | null;
    thumbnailUrl?: string | null;
    artist?:
        | {
              name?: string | null;
          }
        | string
        | null;
    album?:
        | {
              title?: string | null;
              coverArt?: string | null;
          }
        | string
        | null;
    streamSource?: ProviderSource | null;
    tidalTrackId?: number | string | null;
    youtubeVideoId?: string | null;
    provider?: {
        source?: ProviderSource | null;
        tidalTrackId?: number | string | null;
        youtubeVideoId?: string | null;
    } | null;
};

function normalizeTidalTrackId(
    value: number | string | null | undefined,
): number | null {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return value;
    }

    if (typeof value === "string" && value.trim()) {
        const trimmed = value.trim();
        if (/^[1-9]\d*$/.test(trimmed)) {
            const parsed = Number(trimmed);
            if (Number.isSafeInteger(parsed)) {
                return parsed;
            }
        }
    }

    return null;
}

function normalizeNonEmptyString(
    value: string | null | undefined,
): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function normalizeDuration(
    value: number | string | null | undefined,
): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    }

    return null;
}

function hasRemotePrefix(trackId: string | null | undefined): boolean {
    if (!trackId) return false;
    return trackId.startsWith("yt:") || trackId.startsWith("tidal:");
}

function prefixedTrackIdRef(
    trackId: string | null | undefined,
): TrackRef | null {
    if (!trackId) return null;

    if (trackId.startsWith("yt:")) {
        const youtubeVideoId = trackId.slice(3);
        if (youtubeVideoId) {
            return {
                youtubeVideoId,
            };
        }
    }

    if (trackId.startsWith("tidal:")) {
        const tidalTrackId = normalizeTidalTrackId(trackId.slice(6));
        if (tidalTrackId !== null) {
            return {
                tidalTrackId,
            };
        }
    }

    return null;
}

/** Resolve provider authority in normalized transport precedence order. */
export function resolveTrackProviderSource(
    input: TrackRefInput,
): ProviderSource | null {
    const sourceFallback =
        input.source === "local" ||
        input.source === "tidal" ||
        input.source === "youtube" ||
        input.source === "audius"
            ? input.source
            : null;
    return (
        input.provider?.source ??
        input.mediaSource ??
        input.streamSource ??
        sourceFallback
    );
}

function resolveYouTubeVideoId(input: TrackRefInput): string | null {
    const explicit = normalizeNonEmptyString(
        input.provider?.youtubeVideoId ?? input.youtubeVideoId,
    );
    if (explicit !== null) {
        return explicit;
    }

    const prefixed = prefixedTrackIdRef(input.id);
    if (prefixed && "youtubeVideoId" in prefixed) {
        return prefixed.youtubeVideoId;
    }

    return null;
}

function resolveTidalTrackId(input: TrackRefInput): number | null {
    const explicit = normalizeTidalTrackId(
        input.provider?.tidalTrackId ?? input.tidalTrackId,
    );
    if (explicit !== null) {
        return explicit;
    }

    const prefixed = prefixedTrackIdRef(input.id);
    if (prefixed && "tidalTrackId" in prefixed) {
        return prefixed.tidalTrackId;
    }

    return null;
}

/** Returns whether the row has an explicit local playback identity. */
export function hasLocalTrackBacking(input: TrackRefInput): boolean {
    return (
        input.hasLocalFile === true ||
        normalizeNonEmptyString(input.filePath) !== null ||
        resolveTrackProviderSource(input) === "local"
    );
}

/**
 * Identifies historical TIDAL-only rows retained for library management after
 * the provider was retired. A real local file or an active YouTube identity
 * takes precedence over incidental legacy TIDAL metadata.
 */
export function isRetiredRemoteOnlyTrack(input: TrackRefInput): boolean {
    if (hasLocalTrackBacking(input)) return false;

    const streamSource = resolveTrackProviderSource(input);
    const hasActiveYouTubeIdentity =
        (streamSource === "youtube" || streamSource === "youtube-direct") &&
        resolveYouTubeVideoId(input) !== null;
    if (hasActiveYouTubeIdentity) return false;

    return (
        streamSource === "tidal" ||
        input.source === "tidal" ||
        input.id?.startsWith("tidal:") === true ||
        input.tidalTrackId != null ||
        input.provider?.tidalTrackId != null
    );
}

/** Shared action fence for retained tracks from retired remote providers. */
export function isTrackActionable(input: TrackRefInput): boolean {
    return !isRetiredRemoteOnlyTrack(input);
}

/** Sources accepted by personal playback but not by persistence/download contracts. */
export function isPlaybackOnlyTrack(input: TrackRefInput): boolean {
    return (
        !hasLocalTrackBacking(input) &&
        (resolveTrackProviderSource(input) === "audius" ||
            input.id?.startsWith("audius:") === true)
    );
}

/**
 * Normalize the identity fields consumed by player, queue, playlist, and
 * device actions. Real local media wins all incidental remote metadata;
 * supported YouTube media receives one canonical provider identity.
 */
export function normalizeActionableAudioTrack(
    track: AudioTrack,
): AudioTrack | null {
    if (isRetiredRemoteOnlyTrack(track)) return null;
    if (hasLocalTrackBacking(track)) {
        return {
            ...track,
            mediaSource: "local",
            provider: undefined,
            source: "local",
            streamSource: undefined,
            tidalTrackId: undefined,
            youtubeVideoId: undefined,
            youtubeAudioFormat: undefined,
        };
    }

    const providerSource = resolveTrackProviderSource(track);
    if (providerSource === "audius") {
        const id = track.provider?.providerTrackId;
        if (
            !id ||
            !/^[A-Za-z0-9]{3,32}$/.test(id) ||
            track.id !== `audius:${id}`
        )
            return null;
        return {
            ...track,
            mediaSource: "audius",
            source: "audius",
            streamSource: "audius",
            provider: { source: "audius", providerTrackId: id },
            tidalTrackId: undefined,
            youtubeVideoId: undefined,
            youtubeAudioFormat: undefined,
        };
    }
    let reference: TrackRef;
    try {
        reference = toTrackRef(track);
    } catch {
        return null;
    }
    if ("tidalTrackId" in reference) return null;
    if (!("youtubeVideoId" in reference)) return track;

    const source =
        providerSource === "youtube-direct" ? "youtube-direct" : "youtube";
    return {
        ...track,
        mediaSource: source,
        provider: {
            ...track.provider,
            source,
            providerTrackId:
                track.provider?.providerTrackId ?? reference.youtubeVideoId,
            tidalTrackId: undefined,
            youtubeVideoId: reference.youtubeVideoId,
        },
        source: "youtube",
        streamSource: source,
        tidalTrackId: undefined,
        youtubeVideoId: reference.youtubeVideoId,
    };
}

function hasPersistedPreferenceIdentity(input: TrackRefInput): boolean {
    return (
        hasLocalTrackBacking(input) ||
        input.source === "federated" ||
        resolveTrackProviderSource(input) === "local"
    );
}

/**
 * Resolves the stable track identity shared by preferences and player surfaces.
 * Persisted local and federated rows retain their database id even when provider
 * metadata has enriched the row for fallback playback.
 */
export function resolvePreferenceTrackId(
    input: TrackRefInput & { id: string },
): string {
    if (hasPersistedPreferenceIdentity(input)) {
        return input.id;
    }

    const providerSource = resolveTrackProviderSource(input);
    const tidalTrackId = resolveTidalTrackId(input);
    const youtubeVideoId = resolveYouTubeVideoId(input);

    if (providerSource === "tidal" && tidalTrackId !== null) {
        return `tidal:${tidalTrackId}`;
    }
    if (
        (providerSource === "youtube" || providerSource === "youtube-direct") &&
        youtubeVideoId
    ) {
        return `yt:${youtubeVideoId}`;
    }

    const prefixed = prefixedTrackIdRef(input.id);
    if (prefixed && "tidalTrackId" in prefixed) {
        return `tidal:${prefixed.tidalTrackId}`;
    }
    if (prefixed && "youtubeVideoId" in prefixed) {
        return `yt:${prefixed.youtubeVideoId}`;
    }
    if (tidalTrackId !== null) {
        return `tidal:${tidalTrackId}`;
    }
    if (youtubeVideoId) {
        return `yt:${youtubeVideoId}`;
    }

    return input.id;
}

/**
 * Returns whether the provided reference shape identifies a non-local provider track.
 */
export function isRemoteTrack(input: TrackRefInput | TrackRef): boolean {
    if ("trackId" in input) {
        return false;
    }

    if (hasLocalTrackBacking(input)) return false;

    const streamSource = resolveTrackProviderSource(input);

    if (
        "youtubeVideoId" in input &&
        normalizeNonEmptyString(input.youtubeVideoId) !== null
    ) {
        return true;
    }

    if (
        "tidalTrackId" in input &&
        normalizeTidalTrackId(input.tidalTrackId) !== null
    ) {
        return true;
    }

    if (hasRemotePrefix((input as TrackRefInput).id)) {
        return true;
    }

    if (resolveYouTubeVideoId(input as TrackRefInput) !== null) {
        return true;
    }

    if (resolveTidalTrackId(input as TrackRefInput) !== null) {
        return true;
    }

    return (
        streamSource === "youtube" ||
        streamSource === "youtube-direct" ||
        streamSource === "tidal" ||
        streamSource === "audius"
    );
}

/**
 * Normalizes mixed track payloads into a strict local/remote track reference union.
 */
export function toTrackRef(input: TrackRefInput): TrackRef {
    const source = resolveTrackProviderSource(input);

    if (hasLocalTrackBacking(input)) {
        if (typeof input.id === "string" && input.id.trim()) {
            return {
                trackId: input.id,
            };
        }
        throw new Error("Local track reference is missing track id");
    }

    if (source === "audius" || input.id?.startsWith("audius:")) {
        throw new Error(
            "Audius supports playback only; playlist and library writes are unavailable",
        );
    }

    if (source === "youtube" || source === "youtube-direct") {
        const youtubeVideoId = resolveYouTubeVideoId(input);
        if (!youtubeVideoId) {
            throw new Error("Remote YouTube track is missing youtubeVideoId");
        }
        return {
            youtubeVideoId,
        };
    }

    if (source === "tidal") {
        const tidalTrackId = resolveTidalTrackId(input);
        if (tidalTrackId === null) {
            throw new Error("Remote TIDAL track is missing tidalTrackId");
        }
        return {
            tidalTrackId,
        };
    }

    const prefixed = prefixedTrackIdRef(input.id);
    if (prefixed) {
        return prefixed;
    }

    const youtubeVideoId = resolveYouTubeVideoId(input);
    if (youtubeVideoId) {
        return {
            youtubeVideoId,
        };
    }

    const tidalTrackId = resolveTidalTrackId(input);
    if (tidalTrackId !== null) {
        return {
            tidalTrackId,
        };
    }

    if (hasRemotePrefix(input.id)) {
        throw new Error("Remote track id prefix is malformed");
    }

    if (typeof input.id === "string" && input.id.trim()) {
        return {
            trackId: input.id,
        };
    }

    throw new Error(
        "Track reference requires a local id or remote provider identifier",
    );
}

function resolveRemoteMetadata(input: TrackRefInput): {
    title: string;
    artist: string;
    album: string;
    duration: number;
} {
    const title = normalizeNonEmptyString(input.title ?? input.displayTitle);
    if (!title) {
        throw new Error("Remote track is missing title metadata");
    }

    let artistName: string | null = null;
    if (typeof input.artist === "string") {
        artistName = normalizeNonEmptyString(input.artist);
    } else {
        artistName = normalizeNonEmptyString(input.artist?.name ?? null);
    }
    if (!artistName) {
        throw new Error("Remote track is missing artist metadata");
    }

    let albumTitle: string | null = null;
    if (typeof input.album === "string") {
        albumTitle = normalizeNonEmptyString(input.album);
    } else {
        albumTitle = normalizeNonEmptyString(input.album?.title ?? null);
    }
    if (!albumTitle) {
        albumTitle = "Single";
    }

    const duration = normalizeDuration(input.duration) ?? 0;

    return {
        title,
        artist: artistName,
        album: albumTitle,
        duration,
    };
}

/**
 * Builds a playlist add payload using provider identifiers and required remote metadata.
 */
export function toAddToPlaylistRef(input: TrackRefInput): AddToPlaylistRef {
    if (isRetiredRemoteOnlyTrack(input)) {
        throw new Error("Retired TIDAL tracks cannot be added to playlists");
    }
    const trackRef = toTrackRef(input);

    if ("trackId" in trackRef) {
        return { trackId: trackRef.trackId };
    }

    const metadata = resolveRemoteMetadata(input);

    if ("tidalTrackId" in trackRef) {
        const isrc = normalizeNonEmptyString(input.isrc);
        if (isrc) {
            return {
                tidalTrackId: trackRef.tidalTrackId,
                ...metadata,
                isrc,
            };
        }

        return {
            tidalTrackId: trackRef.tidalTrackId,
            ...metadata,
        };
    }

    const thumbnailUrl = normalizeNonEmptyString(input.thumbnailUrl);
    if (thumbnailUrl) {
        return {
            youtubeVideoId: trackRef.youtubeVideoId,
            ...metadata,
            thumbnailUrl,
        };
    }

    return {
        youtubeVideoId: trackRef.youtubeVideoId,
        ...metadata,
    };
}
