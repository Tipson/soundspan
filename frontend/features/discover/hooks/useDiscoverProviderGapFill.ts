import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { DiscoverTrack } from "../types";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    hasNativeDiscoverIdentity,
    mapDiscoverTrackToPlaybackTrack,
} from "../playback";

interface YtMatch {
    videoId: string;
}

interface GapFillResult {
    tracks: DiscoverTrack[];
    isMatching: boolean;
    providerCounts: {
        local: number;
        youtube: number;
        vk: number;
        yandex: number;
    };
}

interface ProviderMatchState {
    key: string;
    tracks: DiscoverTrack[];
    isMatching: boolean;
}

function getTracksKey(tracks: DiscoverTrack[]): string {
    return tracks
        .map((track) =>
            JSON.stringify([
                track.id,
                track.similarity,
                track.duration,
                track.streamSource,
                track.youtubeVideoId,
                track.tidalTrackId,
                track.recommendationGenerationId,
                track.sourceType,
                track.source,
                track.mediaSource,
                track.provider,
                track.musicSourceRecording,
            ]),
        )
        .join("|");
}

function hasResolvedProvider(track: DiscoverTrack): boolean {
    return hasNativeDiscoverIdentity(track)
        ? mapDiscoverTrackToPlaybackTrack(track) !== null
        : !!(track.streamSource === "youtube" && track.youtubeVideoId);
}

function toResolvedTrack(track: DiscoverTrack): DiscoverTrack | null {
    if (hasNativeDiscoverIdentity(track)) {
        const native = mapDiscoverTrackToPlaybackTrack(track);
        return native
            ? { ...track, musicSourceRecording: native.musicSourceRecording }
            : null;
    }
    if (hasResolvedProvider(track)) return track;
    return {
        ...track,
        sourceType: "local",
        streamSource: undefined,
        tidalTrackId: undefined,
        youtubeVideoId: undefined,
    };
}

/**
 * Executes applyDiscoverProviderGapFill.
 */
export function applyDiscoverProviderGapFill(
    sourceTracks: DiscoverTrack[],
    gapIndices: number[],
    ytMatches: Array<YtMatch | null>,
): DiscoverTrack[] {
    const gapSet = new Set(gapIndices);
    let matchIdx = 0;

    return sourceTracks.flatMap((track, index) => {
        const ytMatch = gapSet.has(index) ? ytMatches[matchIdx++] : null;
        if (hasNativeDiscoverIdentity(track)) {
            const native = toResolvedTrack(track);
            return native ? [native] : [];
        }
        // Already available locally — keep as-is
        if (!gapSet.has(index)) {
            return [toResolvedTrack(track)!];
        }

        if (ytMatch) {
            return [
                {
                    ...track,
                    sourceType: "youtube",
                    streamSource: "youtube",
                    youtubeVideoId: ytMatch.videoId,
                    tidalTrackId: undefined,
                },
            ];
        }

        return [toResolvedTrack(track)!];
    });
}

/**
 * Executes useDiscoverProviderGapFill.
 */
export function useDiscoverProviderGapFill(
    tracks: DiscoverTrack[] | undefined,
): GapFillResult {
    const sourceTracks = useMemo(
        () =>
            (tracks || []).flatMap((track) => {
                if (!hasNativeDiscoverIdentity(track)) return [track];
                const native = toResolvedTrack(track);
                return native ? [native] : [];
            }),
        [tracks],
    );
    const tracksKey = useMemo(() => getTracksKey(sourceTracks), [sourceTracks]);

    const [matchState, setMatchState] = useState<ProviderMatchState>({
        key: "",
        tracks: [],
        isMatching: false,
    });

    useEffect(() => {
        if (sourceTracks.length === 0) {
            return;
        }

        let cancelled = false;

        const matchProviders = async () => {
            const gapIndices = sourceTracks.flatMap((track, index) =>
                !track.available && !hasResolvedProvider(track) ? [index] : [],
            );
            if (gapIndices.length === 0) {
                setMatchState({
                    key: tracksKey,
                    tracks: sourceTracks
                        .map(toResolvedTrack)
                        .filter(
                            (track): track is DiscoverTrack => track !== null,
                        ),
                    isMatching: false,
                });
                return;
            }
            setMatchState({
                key: tracksKey,
                tracks: sourceTracks,
                isMatching: true,
            });

            const ytStatus = await api.getYtMusicStatus().catch(() => null);

            if (cancelled) return;

            // Match/search uses public sidecar client — no user OAuth required
            const ytAvailable = !!ytStatus?.enabled && !!ytStatus?.available;

            if (!ytAvailable) {
                setMatchState({
                    key: tracksKey,
                    tracks: sourceTracks
                        .map(toResolvedTrack)
                        .filter(
                            (track): track is DiscoverTrack => track !== null,
                        ),
                    isMatching: false,
                });
                return;
            }

            const payload = gapIndices.map((i) => {
                const track = sourceTracks[i];
                return {
                    artist: track.artist,
                    title: track.title,
                    albumTitle: track.album,
                    duration:
                        typeof track.duration === "number" && track.duration > 0
                            ? track.duration
                            : undefined,
                };
            });

            const ytMatchesResponse = await api
                .matchYtMusicBatch(payload)
                .catch(() => ({ matches: [] }));

            if (cancelled) return;

            const ytMatches =
                ytMatchesResponse.matches as Array<YtMatch | null>;
            const nextTracks = applyDiscoverProviderGapFill(
                sourceTracks,
                gapIndices,
                ytMatches,
            );

            setMatchState({
                key: tracksKey,
                tracks: nextTracks,
                isMatching: false,
            });
        };

        matchProviders().catch((error) => {
            sharedFrontendLogger.error(
                "[DiscoverGapFill] Provider matching failed:",
                error,
            );
            if (!cancelled) {
                setMatchState({
                    key: tracksKey,
                    tracks: sourceTracks,
                    isMatching: false,
                });
            }
        });

        return () => {
            cancelled = true;
        };
    }, [tracksKey, sourceTracks]);

    const effectiveTracks = useMemo(
        () =>
            sourceTracks.length === 0
                ? []
                : matchState.key === tracksKey
                  ? matchState.tracks
                  : sourceTracks,
        [matchState.key, matchState.tracks, sourceTracks, tracksKey],
    );
    const isMatching =
        sourceTracks.length > 0 &&
        (matchState.key !== tracksKey || matchState.isMatching);

    const providerCounts = useMemo(() => {
        const counts = {
            local: 0,
            youtube: 0,
            vk: 0,
            yandex: 0,
        };

        for (const track of effectiveTracks) {
            if (track.sourceType === "youtube") {
                counts.youtube += 1;
            } else if (track.sourceType === "vk") {
                counts.vk += 1;
            } else if (track.sourceType === "yandex") {
                counts.yandex += 1;
            } else {
                counts.local += 1;
            }
        }

        return counts;
    }, [effectiveTracks]);

    return {
        tracks: effectiveTracks,
        isMatching,
        providerCounts,
    };
}
