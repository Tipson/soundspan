"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Music, Play } from "lucide-react";
import { DiscoverResult } from "../types";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { isListenTogetherActiveOrPending } from "@/lib/listen-together-session";
import { getArtistRouteParam } from "@/utils/artistRoute";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { CachedImage } from "@/components/ui/CachedImage";
import { toMusicSourcePlaybackTrack } from "@/lib/audio/musicSourcePlayback";
import {
    formatGoToSearchArtistAria,
    formatPlaySearchTrackAria,
} from "@/lib/i18n/searchExtrasRu";
import {
    useSearchTrackMatches,
    type SearchMatchTarget,
    type SearchProviderMatch,
} from "../hooks/useSearchTrackMatches";

interface DiscoverTracksListProps {
    tracks: DiscoverResult[];
    limit?: number | null;
}

const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 100);
};

const getTrackArtistHref = (track: DiscoverResult): string | null => {
    if (!track.artist) return null;
    const routeParam =
        getArtistRouteParam(
            { name: track.artist },
            { preferLibraryId: false },
        ) || encodeURIComponent(track.artist);
    return `/artist/${routeParam}`;
};

function rowKey(track: DiscoverResult, index: number): string {
    return `discover-track-${track.id || track.name}-${index}`;
}
function versionKey(track: DiscoverResult): string {
    return track.musicSourceRecording
        ? `${track.musicSourceRecording.provider}:${track.musicSourceRecording.id}`
        : `youtube:${track.youtubeVideoId ?? track.id ?? ""}`;
}

function toPlaybackTrack(
    track: DiscoverResult,
    key: string,
    match: SearchProviderMatch,
) {
    if (match.musicSourceRecording)
        return toMusicSourcePlaybackTrack(match.musicSourceRecording);
    const playbackId = match.youtubeVideoId
        ? `yt:${match.youtubeVideoId}`
        : key;
    return {
        id: playbackId,
        title: track.name,
        artist: { name: track.artist ?? "" },
        album: { title: track.album ?? "" },
        duration: match.duration ?? track.duration ?? 0,
        streamSource: match.source,
        youtubeVideoId: match.youtubeVideoId,
    };
}

function getDirectProviderMatch(
    track: DiscoverResult,
): SearchProviderMatch | null {
    if (track.musicSourceRecording)
        return {
            source: track.musicSourceRecording.provider,
            musicSourceRecording: track.musicSourceRecording,
            duration: track.musicSourceRecording.duration,
        };
    if (track.streamSource === "youtube" && track.youtubeVideoId) {
        return {
            source: "youtube",
            youtubeVideoId: track.youtubeVideoId,
            duration: track.duration ?? undefined,
        };
    }
    return null;
}

/**
 * Renders external catalog track results. Rows with exact provider identities
 * play directly, metadata-only rows use provider matching, and unmatched rows
 * link to the artist page.
 */
export function DiscoverTracksList({
    tracks,
    limit = 10,
}: DiscoverTracksListProps) {
    const router = useRouter();
    const { playTracks } = useAudioControls();
    const [selections, setSelections] = useState<Record<string, string>>({});
    const [playbackNotice, setPlaybackNotice] = useState("");

    const visibleTracks = useMemo(
        () =>
            (limit === null ? tracks : tracks.slice(0, limit)).map(
                (track, index) => {
                    const selected = track.versions?.find(
                        (version) =>
                            versionKey(version) ===
                            selections[rowKey(track, index)],
                    );
                    return selected
                        ? {
                              ...selected,
                              id: track.id,
                              versions: track.versions,
                          }
                        : track;
                },
            ),
        [tracks, limit, selections],
    );

    const directMatches = useMemo(() => {
        const direct = new Map<string, SearchProviderMatch>();
        visibleTracks.forEach((track, index) => {
            const match = getDirectProviderMatch(track);
            if (match) direct.set(rowKey(track, index), match);
        });
        return direct;
    }, [visibleTracks]);

    const matchTargets = useMemo(
        (): SearchMatchTarget[] =>
            visibleTracks.flatMap((track, index) => {
                if (!track.artist || getDirectProviderMatch(track)) return [];
                return [
                    {
                        key: rowKey(track, index),
                        artist: track.artist,
                        title: track.name,
                        album: track.album ?? undefined,
                    },
                ];
            }),
        [visibleTracks],
    );
    const { matches: resolvedMatches } = useSearchTrackMatches(matchTargets);
    const matches = useMemo(() => {
        const merged = new Map(resolvedMatches);
        directMatches.forEach((match, key) => merged.set(key, match));
        return merged;
    }, [directMatches, resolvedMatches]);

    const playableQueue = useMemo(
        () =>
            visibleTracks.flatMap((track, index) => {
                const key = rowKey(track, index);
                const match = matches.get(key);
                return match
                    ? [{ key, track: toPlaybackTrack(track, key, match) }]
                    : [];
            }),
        [matches, visibleTracks],
    );

    const handleRowClick = useCallback(
        (track: DiscoverResult, key: string) => {
            const match = matches.get(key);
            if (match) {
                const together = isListenTogetherActiveOrPending();
                if (together && match.musicSourceRecording) {
                    setPlaybackNotice(
                        "Этот источник доступен для личного прослушивания. Сначала выйдите из совместной сессии.",
                    );
                    return;
                }
                setPlaybackNotice("");
                const eligibleQueue = together
                    ? playableQueue.filter(
                          (item) => !item.track.musicSourceRecording,
                      )
                    : playableQueue;
                const selectedIndex = eligibleQueue.findIndex(
                    (candidate) => candidate.key === key,
                );
                if (selectedIndex < 0) return;
                playTracks(
                    eligibleQueue.map((candidate) => candidate.track),
                    selectedIndex,
                );
                return;
            }
            const artistHref = getTrackArtistHref(track);
            if (artistHref) router.push(artistHref);
        },
        [matches, playableQueue, playTracks, router],
    );

    if (tracks.length === 0) {
        return null;
    }

    return (
        <div className="space-y-1.5" data-tv-section="search-discover-tracks">
            {playbackNotice && (
                <p role="status" className="p-3 text-sm text-content-secondary">
                    {playbackNotice}
                </p>
            )}
            {visibleTracks.map((track, index) => {
                const imageUrl = getProxiedImageUrl(track.image);
                const key = rowKey(track, index);
                const match = matches.get(key);
                const isPlayable = Boolean(match);
                const actionTrack = match
                    ? toPlaybackTrack(track, key, match)
                    : {
                          id: key,
                          title: track.name,
                          artist: { name: track.artist ?? "" },
                          album: { title: track.album ?? "" },
                          duration: track.duration ?? 0,
                      };

                return (
                    <div
                        key={key}
                        role="button"
                        tabIndex={0}
                        data-tv-card
                        data-tv-card-index={index}
                        onClick={() => handleRowClick(track, key)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleRowClick(track, key);
                            }
                        }}
                        className="group flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 transition-colors hover:border-white/[0.06] hover:bg-white/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:gap-4 sm:px-3"
                        aria-label={
                            isPlayable
                                ? formatPlaySearchTrackAria(
                                      track.name,
                                      track.artist,
                                  )
                                : formatGoToSearchArtistAria(track.artist)
                        }
                    >
                        <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-elevated">
                            {imageUrl ? (
                                <CachedImage
                                    src={imageUrl}
                                    alt={track.name}
                                    fill
                                    sizes="40px"
                                    className="object-cover"
                                    fallback={
                                        <Music className="h-5 w-5 text-content-muted" />
                                    }
                                />
                            ) : (
                                <Music className="h-5 w-5 text-content-muted" />
                            )}
                            {isPlayable && (
                                <div className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/50">
                                    <Play className="w-4 h-4 text-white" />
                                </div>
                            )}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="flex truncate text-sm font-semibold text-content items-center gap-1.5">
                                <span className="truncate">{track.name}</span>
                                {match?.source === "youtube" && (
                                    <YouTubeBadge />
                                )}
                                {match?.source === "vk" ||
                                match?.source === "yandex" ? (
                                    <span className="shrink-0 text-[10px] font-normal text-content-muted">
                                        {match.source === "vk"
                                            ? "VK"
                                            : "Яндекс"}
                                    </span>
                                ) : null}
                            </p>
                            <p className="truncate text-xs text-content-secondary">
                                {track.artist}
                                {track.album ? ` — ${track.album}` : ""}
                            </p>
                            {track.versions && track.versions.length > 1 ? (
                                <select
                                    aria-label={`Источник и версия: ${track.name}`}
                                    className="mt-1 min-h-11 max-w-full rounded-lg border border-line-strong bg-surface-elevated px-2 text-xs text-content-secondary"
                                    value={versionKey(track)}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        setSelections((previous) => ({
                                            ...Object.fromEntries(
                                                Object.entries(previous).slice(
                                                    -99,
                                                ),
                                            ),
                                            [key]: value,
                                        }));
                                    }}
                                >
                                    {track.versions.map((version) => (
                                        <option
                                            key={versionKey(version)}
                                            value={versionKey(version)}
                                        >
                                            {version.musicSourceRecording
                                                ?.provider === "vk"
                                                ? "VK"
                                                : version.musicSourceRecording
                                                        ?.provider === "yandex"
                                                  ? "Яндекс Музыка"
                                                  : "YouTube Music"}
                                            {version.musicSourceRecording
                                                ?.contentVersion === "explicit"
                                                ? " · Explicit"
                                                : version.musicSourceRecording
                                                        ?.contentVersion ===
                                                    "clean"
                                                  ? " · С цензурой"
                                                  : " · Версия не отмечена"}
                                        </option>
                                    ))}
                                </select>
                            ) : null}
                        </div>
                        <div
                            className="flex items-center"
                            role="presentation"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                        >
                            <TrackOverflowMenu
                                track={actionTrack}
                                triggerClassName="h-11 w-11 p-0"
                                showPlayNext={
                                    isPlayable && !match?.musicSourceRecording
                                }
                                showAddToQueue={
                                    isPlayable && !match?.musicSourceRecording
                                }
                                showAddToPlaylist={isPlayable}
                                showMatchVibe={false}
                                showVibeMap={false}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
