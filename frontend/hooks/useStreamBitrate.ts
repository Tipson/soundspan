import { useState, useEffect } from "react";
import { useAudioState, usePlaybackStatus } from "@/lib/audio-context";
import { api } from "@/lib/api";

// ── Local track quality info ───────────────────────────────────────

export interface LocalTrackQuality {
    /** Codec name: FLAC, MPEG 1 Layer 3, AAC, Vorbis, etc. */
    codec: string;
    /** Bitrate in kbps (meaningful for lossy; variable for lossless) */
    bitrate: number | null;
    /** Sample rate in Hz (e.g. 44100, 96000) */
    sampleRate: number | null;
    /** Bit depth (e.g. 16, 24, 32) */
    bitDepth: number | null;
    /** Whether the format is lossless */
    lossless: boolean;
}

/** Map raw music-metadata codec names to short friendly labels */
const CODEC_FRIENDLY_NAMES: Record<string, string> = {
    "MPEG 1 Layer 3": "MP3",
    "MPEG 2 Layer 3": "MP3",
    "MPEG 2.5 Layer 3": "MP3",
    "MPEG 4/ISO/AVC": "AAC",
    Vorbis: "OGG",
    Opus: "Opus",
    ALAC: "ALAC",
    FLAC: "FLAC",
    PCM: "WAV",
    WMA: "WMA",
    DSD: "DSD",
};

// Shared across all hook instances so Mini/Full players do not duplicate requests.
const ytInfoCache = new Map<string, { abr: number; acodec: string }>();
const ytInfoInFlight = new Map<
    string,
    Promise<{ abr: number; acodec: string }>
>();
const localInfoCache = new Map<string, LocalTrackQuality>();
const localInfoInFlight = new Map<string, Promise<LocalTrackQuality>>();
const localPlaybackInfoCache = new Map<string, LocalTrackQuality>();
const localPlaybackInfoInFlight = new Map<string, Promise<LocalTrackQuality>>();

function fetchYtStreamInfo(
    videoId: string,
): Promise<{ abr: number; acodec: string }> {
    const cached = ytInfoCache.get(videoId);
    if (cached) return Promise.resolve(cached);

    const inFlight = ytInfoInFlight.get(videoId);
    if (inFlight) return inFlight;

    const request = api
        .getYtMusicStreamInfo(videoId, undefined, { cachedOnly: true })
        .then((info) => {
            const normalized = {
                abr: info.abr,
                acodec: info.acodec,
            };
            // A cache miss is unknown, not a permanent zero-bitrate result.
            if (normalized.abr > 0 || normalized.acodec) {
                ytInfoCache.set(videoId, normalized);
            }
            return normalized;
        })
        .finally(() => {
            ytInfoInFlight.delete(videoId);
        });

    ytInfoInFlight.set(videoId, request);
    return request;
}

function fetchLocalTrackQuality(
    trackId: string,
    options: { playback: boolean },
): Promise<LocalTrackQuality> {
    const cache = options.playback ? localPlaybackInfoCache : localInfoCache;
    const inFlightMap = options.playback
        ? localPlaybackInfoInFlight
        : localInfoInFlight;
    const cached = cache.get(trackId);
    if (cached) return Promise.resolve(cached);

    const inFlight = inFlightMap.get(trackId);
    if (inFlight) return inFlight;

    const request = api
        .getLocalTrackAudioInfo(trackId, {
            playback: options.playback,
        })
        .then((info) => {
            const normalized: LocalTrackQuality = {
                codec: info.codec || "Unknown",
                bitrate: info.bitrate,
                sampleRate: info.sampleRate,
                bitDepth: info.bitDepth,
                lossless: info.lossless ?? false,
            };
            cache.set(trackId, normalized);
            return normalized;
        })
        .finally(() => {
            inFlightMap.delete(trackId);
        });

    inFlightMap.set(trackId, request);
    return request;
}

/**
 * Executes friendlyCodecName.
 */
export function friendlyCodecName(raw: string): string {
    return CODEC_FRIENDLY_NAMES[raw] || raw;
}

/**
 * Executes formatSampleRateKHz.
 */
export function formatSampleRateKHz(hz?: number | null): string | null {
    if (!hz || !Number.isFinite(hz) || hz <= 0) return null;
    const khz = hz / 1000;
    const label = Number.isInteger(khz)
        ? khz.toString()
        : khz.toFixed(1).replace(/\.0$/, "");
    return `${label}kHz`;
}

function normalizeCodecLabel(raw?: string | null): string | null {
    if (!raw) return null;
    const normalized = raw.trim();
    if (!normalized) return null;
    return friendlyCodecName(normalized).toUpperCase();
}

/**
 * Executes resolveEffectiveLocalPlaybackQuality.
 */
export function resolveEffectiveLocalPlaybackQuality(input: {
    sourceQuality: LocalTrackQuality | null;
    playbackQuality: LocalTrackQuality | null;
    streamProfile: {
        mode: "direct";
        sourceType:
            | "local"
            | "peer"
            | "tidal"
            | "ytmusic"
            | "audius"
            | "unknown";
        codec: string | null;
        bitrateKbps: number | null;
    } | null;
}): LocalTrackQuality | null {
    if (!input.streamProfile || input.streamProfile.sourceType !== "local") {
        return input.sourceQuality;
    }

    return input.playbackQuality ?? input.sourceQuality;
}

/**
 * Executes formatLocalQualityBadge.
 */
export function formatLocalQualityBadge(
    quality?: LocalTrackQuality | null,
): string | null {
    if (!quality) return null;
    const codec = normalizeCodecLabel(quality.codec);
    const codecLabel = codec || "UNKNOWN";

    if (quality.lossless) {
        const sampleRate = formatSampleRateKHz(quality.sampleRate);
        if (sampleRate) {
            return `${codecLabel} · ${quality.bitDepth || "?"}/${sampleRate}`;
        }
        return codecLabel;
    }

    if (quality.bitrate && quality.bitrate > 0) {
        return `${codecLabel} · ${Math.round(quality.bitrate)} kbps`;
    }
    return codecLabel;
}

/**
 * Executes formatYtQualityBadge.
 */
export function formatYtQualityBadge(
    codec?: string | null,
    bitrate?: number | null,
): string | null {
    const codecLabel = normalizeCodecLabel(codec);
    const bitrateLabel =
        bitrate && bitrate > 0 ? `${Math.round(bitrate)} kbps` : null;

    if (codecLabel && bitrateLabel) return `${codecLabel} · ${bitrateLabel}`;
    if (codecLabel) return codecLabel;
    if (bitrateLabel) return bitrateLabel;
    return null;
}

export interface PlaybackQualityBadge {
    variant: "youtube" | "local";
    label: string;
}

export type PlaybackStreamSource =
    | "local"
    | "peer"
    | "youtube"
    | "youtube-direct";

/**
 * Executes resolvePlaybackQualityBadge.
 */
export function resolvePlaybackQualityBadge(input: {
    streamSource?: PlaybackStreamSource;
    localQuality: LocalTrackQuality | null;
    codec: string | null;
    bitrate: number | null;
}): PlaybackQualityBadge | null {
    if (input.streamSource === "youtube") {
        return {
            variant: "youtube",
            label:
                formatYtQualityBadge(input.codec, input.bitrate) || "Unknown",
        };
    }

    const localLabel = formatLocalQualityBadge(input.localQuality);
    if (!localLabel) {
        return null;
    }

    return {
        variant: "local",
        label: localLabel,
    };
}

/**
 * Executes resolvePlaybackQualityBadgeFromStreamSource.
 */
export function resolvePlaybackQualityBadgeFromStreamSource(
    streamSource: PlaybackStreamSource | undefined,
): PlaybackQualityBadge | null {
    return resolvePlaybackQualityBadge({
        streamSource,
        localQuality: null,
        codec: null,
        bitrate: null,
    });
}

/**
 * Returns audio quality metadata for the currently playing track:
 *   - YouTube Music: bitrate (kbps) + codec
 *   - Local: codec + bitrate / bit depth / sample rate
 *
 * Fetches info from the backend the first time a track starts
 * playing and caches results so repeat plays don't trigger extra
 * requests.
 */
export function useStreamBitrate(): {
    bitrate: number | null;
    codec: string | null;
    localQuality: LocalTrackQuality | null;
    qualityBadge: PlaybackQualityBadge | null;
} {
    const { currentTrack, playbackType } = useAudioState();
    const { streamProfile, isPlaying, isBuffering } = usePlaybackStatus();
    const [bitrate, setBitrate] = useState<number | null>(null);
    const [codec, setCodec] = useState<string | null>(null);
    const [localQuality, setLocalQuality] = useState<LocalTrackQuality | null>(
        null,
    );
    const [localPlaybackQuality, setLocalPlaybackQuality] =
        useState<LocalTrackQuality | null>(null);

    // ── YouTube Music stream info ──────────────────────────────────
    useEffect(() => {
        if (
            playbackType !== "track" ||
            !isPlaying ||
            isBuffering ||
            !currentTrack ||
            currentTrack.streamSource !== "youtube" ||
            !currentTrack.youtubeVideoId
        ) {
            setBitrate(null);
            setCodec(null);
            return;
        }

        const videoId = currentTrack.youtubeVideoId;
        let cancelled = false;

        fetchYtStreamInfo(videoId)
            .then((info) => {
                if (cancelled) return;
                setBitrate(info.abr);
                setCodec(info.acodec);
            })
            .catch(() => {
                if (!cancelled) {
                    setBitrate(null);
                    setCodec(null);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [currentTrack, playbackType, isPlaying, isBuffering]);

    // ── Local track quality info ───────────────────────────────────
    useEffect(() => {
        // Local tracks have no streamSource (or streamSource === "local")
        // and always have an id that isn't a synthetic lastfm-* id.
        // Peer tracks are library rows synced from a federation peer:
        // their quality metadata lives on the local Track row, so they
        // use the same metadata lookup as local tracks.
        const isLocal =
            playbackType === "track" &&
            currentTrack &&
            (!currentTrack.streamSource ||
                currentTrack.streamSource === "peer") &&
            currentTrack.id &&
            !currentTrack.id.startsWith("lastfm-");

        if (!isLocal) {
            setLocalQuality(null);
            return;
        }

        const trackId = currentTrack!.id;
        let cancelled = false;

        fetchLocalTrackQuality(trackId, { playback: false })
            .then((quality) => {
                if (cancelled) return;
                setLocalQuality(quality);
            })
            .catch(() => {
                if (!cancelled) setLocalQuality(null);
            });

        return () => {
            cancelled = true;
        };
    }, [currentTrack, playbackType]);

    // ── Local playback-target quality info (direct mode) ───────────
    useEffect(() => {
        const isLocalDirectPlayback =
            playbackType === "track" &&
            !!currentTrack &&
            !currentTrack.streamSource &&
            !!currentTrack.id &&
            !currentTrack.id.startsWith("lastfm-") &&
            streamProfile?.sourceType === "local" &&
            streamProfile.mode === "direct";

        if (!isLocalDirectPlayback) {
            setLocalPlaybackQuality(null);
            return;
        }

        const trackId = currentTrack!.id;
        let cancelled = false;

        fetchLocalTrackQuality(trackId, { playback: true })
            .then((quality) => {
                if (cancelled) return;
                setLocalPlaybackQuality(quality);
            })
            .catch(() => {
                if (!cancelled) setLocalPlaybackQuality(null);
            });

        return () => {
            cancelled = true;
        };
    }, [currentTrack, playbackType, streamProfile]);

    const effectiveLocalQuality =
        playbackType === "track" && currentTrack
            ? resolveEffectiveLocalPlaybackQuality({
                  sourceQuality: localQuality,
                  playbackQuality: localPlaybackQuality,
                  streamProfile:
                      !currentTrack.streamSource &&
                      streamProfile?.sourceType === "local"
                          ? streamProfile
                          : null,
              })
            : null;

    const qualityBadge =
        playbackType === "track" && currentTrack
            ? resolvePlaybackQualityBadge({
                  streamSource:
                      currentTrack.streamSource === "youtube"
                          ? "youtube"
                          : undefined,
                  localQuality: effectiveLocalQuality,
                  codec,
                  bitrate,
              })
            : null;

    return {
        bitrate,
        codec,
        localQuality,
        qualityBadge,
    };
}
