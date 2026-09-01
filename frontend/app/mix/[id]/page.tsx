"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
    ListPlus,
    Loader2,
    Music,
    Pause,
    Play,
    Save,
    Shuffle,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import {
    useAudioControls,
    useAudioState,
    usePlaybackStatus,
} from "@/lib/audio-context";
import {
    MusicDetailActionDock,
    MusicDetailHero,
    MusicDetailTrackSurface,
} from "@/components/music-detail";
import { TrackList, TrackListHeader } from "@/components/track";
import type { RowState, TrackRowItem, TrackRowSlots } from "@/components/track";
import { CoverMosaic } from "@/components/ui/CoverMosaic";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useFeatures } from "@/lib/features-context";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    formatMixDuration,
    formatMixTrackCount,
    mixRu,
} from "@/lib/i18n/musicPagesRu";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { useMixQuery } from "@/hooks/useQueries";
import { shuffleArray } from "@/utils/shuffle";

interface MixTrack {
    id: string;
    title: string;
    duration: number;
    albumId: string;
    album: {
        title: string;
        coverUrl?: string | null;
        artist: {
            id: string;
            name: string;
        };
    };
}

function mixTrackToPlaybackTrack(track: MixTrack): Track {
    return {
        id: track.id,
        title: track.title,
        artist: {
            name: track.album.artist.name,
            id: track.album.artist.id,
        },
        album: {
            title: track.album.title,
            coverArt: track.album.coverUrl ?? undefined,
            id: track.albumId,
        },
        duration: track.duration,
    };
}

function mixTrackToRowItem(track: MixTrack): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        artistName: track.album.artist.name,
        duration: track.duration,
        coverArtUrl: track.album.coverUrl
            ? api.getCoverArtUrl(track.album.coverUrl, 100)
            : null,
    };
}

/** Generated mix detail guarded by the automatic-playlists feature flag. */
export default function MixPage() {
    const { autoPlaylists, loading: featuresLoading } = useFeatures();

    if (featuresLoading) {
        return <LoadingScreen message="Проверяем доступность миксов…" />;
    }

    if (!autoPlaylists) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-surface px-4">
                <EmptyState
                    icon={<Music className="h-7 w-7" aria-hidden="true" />}
                    title={mixRu.unavailable}
                    description={mixRu.disabled}
                />
            </main>
        );
    }

    return <MixPageContent />;
}

function MixPageContent() {
    const params = useParams();
    const router = useRouter();
    const mixId = params.id as string;
    const { currentTrack } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    const { playTracks, addToQueue, pause, resume } = useAudioControls();
    const { data: mix, isLoading } = useMixQuery(mixId);
    const [isSaving, setIsSaving] = useState(false);
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();
    const tracks = useMemo(
        () => (mix?.tracks ?? []) as MixTrack[],
        [mix?.tracks],
    );

    const totalDuration = useMemo(
        () => tracks.reduce((sum, track) => sum + (track.duration || 0), 0),
        [tracks],
    );
    const mixTrackIds = useMemo(
        () => new Set(tracks.map((track) => track.id)),
        [tracks],
    );
    const isThisMixPlaying = Boolean(
        isPlaying && currentTrack && mixTrackIds.has(currentTrack.id),
    );

    const handlePlayMix = () => {
        if (tracks.length === 0) return;
        triggerPlayFeedback();

        if (isThisMixPlaying) {
            if (isPlaying) pause();
            else resume();
            return;
        }

        playTracks(tracks.map(mixTrackToPlaybackTrack), 0);
    };

    const handlePlayTrack = (index: number) => {
        if (tracks.length === 0) return;
        playTracks(tracks.map(mixTrackToPlaybackTrack), index);
    };

    const handleShuffle = () => {
        if (tracks.length === 0) return;
        playTracks(shuffleArray(tracks.map(mixTrackToPlaybackTrack)), 0);
    };

    const handleSaveAsPlaylist = async () => {
        if (!mix) return;

        setIsSaving(true);
        try {
            const result = await api.saveMixAsPlaylist(mixId);
            toast.success(`${mixRu.saveSuccess}: «${result.name}»`);
            window.dispatchEvent(new Event("playlist-created"));
            setTimeout(() => router.push(`/playlist/${result.id}`), 1000);
        } catch (error: unknown) {
            sharedFrontendLogger.error(
                "Failed to save mix as playlist:",
                error,
            );
            const err = error as {
                status?: number;
                data?: { playlistId?: string };
            };
            if (err?.status === 409) {
                toast.info(mixRu.alreadySaved);
                if (err.data?.playlistId) {
                    setTimeout(
                        () => router.push(`/playlist/${err.data!.playlistId}`),
                        1000,
                    );
                }
            } else {
                toast.error(mixRu.saveFailed);
            }
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) {
        return <LoadingScreen message="Собираем микс…" />;
    }

    if (!mix) {
        return (
            <main
                role="alert"
                className="flex min-h-screen items-center justify-center bg-surface px-4"
            >
                <EmptyState
                    icon={<Music className="h-7 w-7" aria-hidden="true" />}
                    title={mixRu.notFound}
                    description="Попробуйте вернуться назад и выбрать другой микс."
                    action={{
                        label: "Назад",
                        onClick: () => router.back(),
                        variant: "secondary",
                    }}
                />
            </main>
        );
    }

    const coverUrls = (mix.coverUrls ?? [])
        .slice(0, 4)
        .map((url: string) => api.getCoverArtUrl(url, 400));

    return (
        <div className="min-h-screen bg-surface">
            <MusicDetailHero
                eyebrow={mixRu.title}
                title={mix.name}
                artworkShape="square"
                description={mix.description ? <p>{mix.description}</p> : null}
                metadata={
                    <>
                        <span>
                            {formatMixTrackCount(
                                mix.trackCount || tracks.length,
                            )}
                        </span>
                        {totalDuration > 0 && (
                            <>
                                <span aria-hidden="true">•</span>
                                <span>{formatMixDuration(totalDuration)}</span>
                            </>
                        )}
                    </>
                }
                artwork={
                    <CoverMosaic
                        coverUrls={coverUrls}
                        imageSizes="(max-width: 640px) 88px, 112px"
                        emptyState={
                            <Music className="h-16 w-16 text-content-muted" />
                        }
                    />
                }
                backgroundImage={coverUrls[0] ?? null}
                actions={
                    <MusicDetailActionDock label={`${mix.name}: действия`}>
                        <div
                            data-detail-action-tier="primary"
                            className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
                        >
                            {tracks.length > 0 && (
                                <button
                                    type="button"
                                    onClick={handlePlayMix}
                                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-brand-hover px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:flex-none"
                                >
                                    {showPlaySpinner ? (
                                        <Loader2 className="h-5 w-5 animate-spin" />
                                    ) : isThisMixPlaying && isPlaying ? (
                                        <Pause className="h-5 w-5 fill-current" />
                                    ) : (
                                        <Play className="ml-0.5 h-5 w-5 fill-current" />
                                    )}
                                    <span>
                                        {isThisMixPlaying && isPlaying
                                            ? "Пауза"
                                            : "Слушать"}
                                    </span>
                                </button>
                            )}
                            {tracks.length > 1 && (
                                <button
                                    type="button"
                                    onClick={handleShuffle}
                                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    title={mixRu.shuffle}
                                    aria-label={mixRu.shuffle}
                                >
                                    <Shuffle className="h-5 w-5" />
                                </button>
                            )}
                        </div>

                        <div
                            data-detail-action-tier="secondary"
                            className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
                        >
                            <button
                                type="button"
                                onClick={handleSaveAsPlaylist}
                                disabled={isSaving}
                                className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                            >
                                {isSaving ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Save className="h-4 w-4" />
                                )}
                                <span>
                                    {isSaving
                                        ? mixRu.saving
                                        : mixRu.saveAsPlaylist}
                                </span>
                            </button>
                        </div>
                    </MusicDetailActionDock>
                }
            />

            <main className="mx-auto max-w-[1800px] px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
                {tracks.length > 0 ? (
                    <MusicDetailTrackSurface label={`${mix.name}: треки`}>
                        <TrackList<MixTrack>
                            items={tracks}
                            toRowItem={mixTrackToRowItem}
                            onPlay={(_track, index) => handlePlayTrack(index)}
                            rowSlots={(track, _index, state: RowState) =>
                                mixTrackSlots(track, state, () =>
                                    addToQueue(mixTrackToPlaybackTrack(track)),
                                )
                            }
                            showCoverArt
                            preferenceMode={null}
                            accentColor="var(--music-action)"
                            rowClassName="grid-cols-[28px_minmax(0,1fr)_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto]"
                            header={
                                <TrackListHeader
                                    className="grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] gap-4"
                                    columns={[
                                        {
                                            label: "#",
                                            className: "text-center",
                                        },
                                        { label: mixRu.tableTitle },
                                        { label: mixRu.tableAlbum },
                                        { label: mixRu.tableDuration },
                                    ]}
                                />
                            }
                        />
                    </MusicDetailTrackSurface>
                ) : (
                    <EmptyState
                        icon={<Music className="h-7 w-7" aria-hidden="true" />}
                        title={mixRu.noTracks}
                        description={mixRu.empty}
                    />
                )}
            </main>
        </div>
    );
}

function mixTrackSlots(
    track: MixTrack,
    state: RowState,
    onAddToQueue: () => void,
): TrackRowSlots {
    return {
        titleBadges: state.isInQueue ? (
            <span className="rounded-full border border-brand/30 bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium text-brand-light">
                {mixRu.inQueue}
            </span>
        ) : null,
        middleColumns: (
            <p className="text-content-muted hidden items-center truncate text-sm md:flex">
                {track.album.title}
            </p>
        ),
        trailingActions: (
            <div className="flex items-center justify-end gap-2">
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onAddToQueue();
                    }}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    title={mixRu.addToQueue}
                    aria-label={`${mixRu.addToQueue}: ${track.title}`}
                >
                    <ListPlus className="h-4 w-4" />
                </button>
            </div>
        ),
    };
}
