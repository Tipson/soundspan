import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { DiscoverTrack } from "../types";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface YtMatch {
    videoId: string;
}

interface GapFillResult {
    tracks: DiscoverTrack[];
    isMatching: boolean;
    providerCounts: {
        local: number;
        youtube: number;
    };
}

interface ProviderMatchState {
    key: string;
    tracks: DiscoverTrack[];
    isMatching: boolean;
}

function getTracksKey(tracks: DiscoverTrack[]): string {
    return tracks
        .map((track) => `${track.id}:${track.similarity}:${track.duration}`)
        .join("|");
}

function toLocalTrack(track: DiscoverTrack): DiscoverTrack {
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

    return sourceTracks.map((track, index) => {
        // Already available locally — keep as-is
        if (!gapSet.has(index)) {
            return toLocalTrack(track);
        }

        const ytMatch = ytMatches[matchIdx];
        matchIdx++;

        if (ytMatch) {
            return {
                ...track,
                sourceType: "youtube",
                streamSource: "youtube",
                youtubeVideoId: ytMatch.videoId,
                tidalTrackId: undefined,
            };
        }

        return toLocalTrack(track);
    });
}

/**
 * Executes useDiscoverProviderGapFill.
 */
export function useDiscoverProviderGapFill(
    tracks: DiscoverTrack[] | undefined,
): GapFillResult {
    const sourceTracks = useMemo(() => tracks || [], [tracks]);
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
            setMatchState({
                key: tracksKey,
                tracks: sourceTracks,
                isMatching: true,
            });

            const ytStatus = await api.getYtMusicStatus().catch(() => null);

            if (cancelled) return;

            // Match/search uses public sidecar client — no user OAuth required
            const ytAvailable = !!ytStatus?.enabled && !!ytStatus?.available;

            // Only gap-fill tracks that aren't locally available
            const gapIndices: number[] = [];
            for (let i = 0; i < sourceTracks.length; i++) {
                if (!sourceTracks[i].available) {
                    gapIndices.push(i);
                }
            }

            if (!ytAvailable || gapIndices.length === 0) {
                setMatchState({
                    key: tracksKey,
                    tracks: sourceTracks.map(toLocalTrack),
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
        };

        for (const track of effectiveTracks) {
            if (track.sourceType === "youtube") {
                counts.youtube += 1;
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
