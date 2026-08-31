"use client";

import {
    useState,
    useEffect,
    useCallback,
    useMemo,
    Suspense,
    type ReactNode,
} from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
    ArrowLeft,
    Play,
    Pause,
    Music2,
    ListMusic,
    Shuffle,
    Plus,
    Heart,
    Loader2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useAudioState, type Track } from "@/lib/audio-state-context";
import { usePlaybackStatus } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { useCollectionLikeAll } from "@/hooks/useCollectionLikeAll";
import type { LikeableTrack } from "@/hooks/useCollectionLikeAll";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { shuffleArray } from "@/utils/shuffle";
import { decodeRouteId } from "@/utils/routeId";
import { cn } from "@/utils/cn";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TrackList, TrackListHeader } from "@/components/track";
import { CachedImage } from "@/components/ui/CachedImage";
import { SaveMusicEntityButton } from "@/features/library/components/SaveMusicEntityButton";
import { DeviceCollectionDownloadButton } from "@/features/device-offline/components/DeviceCollectionDownloadButton";
import {
    MusicDetailActionDock,
    MusicDetailHero,
    MusicDetailTrackSurface,
} from "@/components/music-detail";
import {
    formatYouTubeChartTrackDescription,
    formatYouTubePlaylistDuration,
    formatYouTubePlaylistTrackCount,
    formatYouTubeTracksAdded,
    formatYouTubeTracksAddedToPlaylist,
    searchExtrasRu,
} from "@/lib/i18n/searchExtrasRu";
import { userFacingError } from "@/lib/i18n/ru";
import type {
    TrackRowItem,
    TrackRowSlots,
    OverflowConfig,
} from "@/components/track";
import type { SavedMusicEntityInput } from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────

interface YtMusicBrowseTrack {
    videoId: string;
    title: string;
    artist: string;
    artists: string[];
    album: string;
    duration: number; // seconds
    thumbnailUrl: string | null;
}

interface YtMusicBrowsePlaylist {
    id: string;
    title: string;
    description: string;
    trackCount: number;
    thumbnailUrl: string | null;
    tracks: YtMusicBrowseTrack[];
    source: string;
}

interface YtMusicSongResponse {
    videoId?: string;
    title?: string;
    artist?: string;
    artists?: Array<string | { name?: string }>;
    album?: string | { title?: string; name?: string };
    duration?: number;
    duration_seconds?: number;
    thumbnailUrl?: string | null;
    thumbnails?: Array<{ url?: string }>;
}

// ── Helpers ────────────────────────────────────────────────────

function browseTrackToQueueTrack(t: YtMusicBrowseTrack): Track {
    return {
        id: `yt:${t.videoId}`,
        title: t.title,
        artist: { name: t.artist },
        album: { title: t.album, coverArt: t.thumbnailUrl || undefined },
        duration: t.duration,
        streamSource: "youtube",
        youtubeVideoId: t.videoId,
    };
}

function isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybeError = error as { status?: number; message?: string };
    if (maybeError.status === 404) return true;
    if (typeof maybeError.message === "string") {
        return maybeError.message.toLowerCase().includes("not found");
    }
    return false;
}

function resolveSongArtist(song: YtMusicSongResponse): string {
    if (typeof song.artist === "string" && song.artist.trim()) {
        return song.artist.trim();
    }

    if (Array.isArray(song.artists)) {
        for (const artist of song.artists) {
            if (typeof artist === "string" && artist.trim()) {
                return artist.trim();
            }
            if (
                artist &&
                typeof artist === "object" &&
                typeof artist.name === "string" &&
                artist.name.trim()
            ) {
                return artist.name.trim();
            }
        }
    }

    return searchExtrasRu.youtubePlaylist.unknownArtist;
}

function resolveSongAlbum(song: YtMusicSongResponse): string {
    if (typeof song.album === "string" && song.album.trim()) {
        return song.album.trim();
    }
    if (
        song.album &&
        typeof song.album === "object" &&
        typeof song.album.title === "string" &&
        song.album.title.trim()
    ) {
        return song.album.title.trim();
    }
    if (
        song.album &&
        typeof song.album === "object" &&
        typeof song.album.name === "string" &&
        song.album.name.trim()
    ) {
        return song.album.name.trim();
    }
    return searchExtrasRu.youtubePlaylist.single;
}

function resolveSongDuration(song: YtMusicSongResponse): number {
    if (
        typeof song.duration_seconds === "number" &&
        song.duration_seconds > 0
    ) {
        return Math.floor(song.duration_seconds);
    }
    if (typeof song.duration === "number" && song.duration > 0) {
        return Math.floor(song.duration);
    }
    return 0;
}

function resolveSongThumbnail(song: YtMusicSongResponse): string | null {
    if (typeof song.thumbnailUrl === "string" && song.thumbnailUrl.trim()) {
        return song.thumbnailUrl;
    }

    if (Array.isArray(song.thumbnails)) {
        for (const thumbnail of song.thumbnails) {
            if (typeof thumbnail?.url === "string" && thumbnail.url.trim()) {
                return thumbnail.url;
            }
        }
    }

    return null;
}

function buildSingleTrackPlaylist(
    song: YtMusicSongResponse,
    fallbackVideoId: string,
): YtMusicBrowsePlaylist {
    const videoId =
        typeof song.videoId === "string" && song.videoId.trim()
            ? song.videoId.trim()
            : fallbackVideoId;
    const title =
        typeof song.title === "string" && song.title.trim()
            ? song.title.trim()
            : searchExtrasRu.youtubePlaylist.fallbackTrackTitle;
    const artist = resolveSongArtist(song);
    const album = resolveSongAlbum(song);
    const duration = resolveSongDuration(song);
    const thumbnailUrl = resolveSongThumbnail(song);

    return {
        id: videoId,
        title,
        description: formatYouTubeChartTrackDescription(artist),
        trackCount: 1,
        thumbnailUrl,
        tracks: [
            {
                videoId,
                title,
                artist,
                artists: [artist],
                album,
                duration,
                thumbnailUrl,
            },
        ],
        source: "ytmusic",
    };
}

function browseToRowItem(track: YtMusicBrowseTrack): TrackRowItem {
    return {
        id: `yt:${track.videoId}`,
        title: track.title,
        artistName: track.artist,
        duration: track.duration,
        coverArtUrl: track.thumbnailUrl
            ? api.getBrowseImageUrl(track.thumbnailUrl)
            : null,
    };
}

function BrowseTrackList({
    tracks,
    onPlayTrack,
}: {
    tracks: YtMusicBrowseTrack[];
    onPlayTrack: (index: number) => void;
}) {
    const handlePlay = useCallback(
        (_track: YtMusicBrowseTrack, index: number) => {
            if (tracks[index]?.videoId) {
                onPlayTrack(index);
            }
        },
        [tracks, onPlayTrack],
    );

    const rowSlots = useCallback(
        (track: YtMusicBrowseTrack): TrackRowSlots => ({
            titleBadges: <YouTubeBadge />,
            middleColumns: (
                <p className="text-content-muted hidden items-center truncate text-sm md:flex">
                    {track.album}
                </p>
            ),
            rowClassName: !track.videoId
                ? "opacity-60 cursor-not-allowed"
                : undefined,
        }),
        [],
    );

    const rowOverflow = useCallback(
        (track: YtMusicBrowseTrack): OverflowConfig | null => {
            if (!track.videoId) return null;
            return {
                track: browseTrackToQueueTrack(track),
                showGoToArtist: false,
                showGoToAlbum: false,
                showMatchVibe: false,
                showStartRadio: false,
            };
        },
        [],
    );

    return (
        <div className="w-full">
            <TrackList
                items={tracks}
                toRowItem={browseToRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                rowOverflow={rowOverflow}
                rowClassName="grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto]"
                accentColor="var(--music-action)"
                preferenceMode="up-only"
                header={
                    <TrackListHeader
                        className="grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] gap-4 mb-2"
                        columns={[
                            { label: "#", className: "text-center" },
                            {
                                label: searchExtrasRu.youtubePlaylist
                                    .tableTitle,
                            },
                            {
                                label: searchExtrasRu.youtubePlaylist
                                    .tableAlbum,
                            },
                            { label: "" },
                        ]}
                    />
                }
            />
        </div>
    );
}

interface YtPlaylistActionDockProps {
    tracks: YtMusicBrowseTrack[];
    collectionId: string;
    collectionLabel: string;
    isAlbumType: boolean;
    providerAlbumEntity: SavedMusicEntityInput | null;
    isThisPlaylistPlaying: boolean;
    isPlaying: boolean;
    showPlaySpinner: boolean;
    likeableTrackCount: number;
    isAllLiked: boolean;
    isApplyingLikeAll: boolean;
    onTogglePlay: () => void;
    onShuffle: () => void;
    onAddToQueue: () => void;
    onAddToPlaylist: () => void;
    onToggleLikeAll: () => void;
    onBack: () => void;
}

/** Action hierarchy shared by YouTube Music album and playlist details. */
export function YtPlaylistActionDock({
    tracks,
    collectionId,
    collectionLabel,
    isAlbumType,
    providerAlbumEntity,
    isThisPlaylistPlaying,
    isPlaying,
    showPlaySpinner,
    likeableTrackCount,
    isAllLiked,
    isApplyingLikeAll,
    onTogglePlay,
    onShuffle,
    onAddToQueue,
    onAddToPlaylist,
    onToggleLikeAll,
    onBack,
}: YtPlaylistActionDockProps) {
    const downloadableTracks = tracks
        .filter((track) => Boolean(track.videoId))
        .map(browseTrackToQueueTrack);
    const likeLabel = isAllLiked
        ? searchExtrasRu.youtubePlaylist.unlikeAll
        : searchExtrasRu.youtubePlaylist.likeAll;

    return (
        <MusicDetailActionDock label={`${collectionLabel}: действия`}>
            <div
                data-detail-action-tier="primary"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
            >
                <button
                    type="button"
                    onClick={onTogglePlay}
                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-brand-hover px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:flex-none"
                >
                    {showPlaySpinner ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                    ) : isThisPlaylistPlaying && isPlaying ? (
                        <Pause className="h-5 w-5 fill-current" />
                    ) : (
                        <Play className="ml-0.5 h-5 w-5 fill-current" />
                    )}
                    <span>
                        {isThisPlaylistPlaying && isPlaying
                            ? searchExtrasRu.youtubePlaylist.pause
                            : searchExtrasRu.youtubePlaylist.playAll}
                    </span>
                </button>
                {tracks.length > 1 && (
                    <button
                        type="button"
                        onClick={onShuffle}
                        className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        title={searchExtrasRu.youtubePlaylist.shuffle}
                        aria-label={searchExtrasRu.youtubePlaylist.shuffle}
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
                    onClick={onAddToQueue}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    title={searchExtrasRu.youtubePlaylist.addAllToQueue}
                    aria-label={searchExtrasRu.youtubePlaylist.addAllToQueue}
                >
                    <ListMusic className="h-5 w-5" />
                </button>
                <button
                    type="button"
                    onClick={onAddToPlaylist}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    title={searchExtrasRu.youtubePlaylist.addAllToPlaylist}
                    aria-label={searchExtrasRu.youtubePlaylist.addAllToPlaylist}
                >
                    <Plus className="h-5 w-5" />
                </button>
                {likeableTrackCount > 0 && (
                    <button
                        type="button"
                        onClick={onToggleLikeAll}
                        disabled={isApplyingLikeAll}
                        className={cn(
                            "flex h-11 w-11 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                            isApplyingLikeAll
                                ? "cursor-not-allowed text-content-muted opacity-50"
                                : isAllLiked
                                  ? "text-brand hover:bg-white/10"
                                  : "text-content-secondary hover:bg-white/10 hover:text-content",
                        )}
                        title={likeLabel}
                        aria-label={likeLabel}
                    >
                        {isApplyingLikeAll ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Heart
                                className={cn(
                                    "h-4 w-4",
                                    isAllLiked && "fill-current",
                                )}
                            />
                        )}
                    </button>
                )}
                {isAlbumType && (
                    <SaveMusicEntityButton entity={providerAlbumEntity} />
                )}
                <DeviceCollectionDownloadButton
                    tracks={downloadableTracks}
                    collectionId={`ytmusic:${collectionId}`}
                    collectionLabel={collectionLabel}
                />
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    <span>{searchExtrasRu.youtubePlaylist.back}</span>
                </button>
            </div>
        </MusicDetailActionDock>
    );
}

interface YtPlaylistEditorialSurfaceProps {
    playlist: YtMusicBrowsePlaylist;
    isAlbumType: boolean;
    totalDuration: number;
    actions: ReactNode;
    onPlayTrack: (index: number) => void;
}

/** Open editorial hero and canonical track surface for YouTube Music details. */
export function YtPlaylistEditorialSurface({
    playlist,
    isAlbumType,
    totalDuration,
    actions,
    onPlayTrack,
}: YtPlaylistEditorialSurfaceProps) {
    const artworkUrl = playlist.thumbnailUrl
        ? api.getBrowseImageUrl(playlist.thumbnailUrl)
        : null;
    return (
        <div className="min-h-screen bg-surface">
            <MusicDetailHero
                eyebrow={
                    isAlbumType
                        ? searchExtrasRu.youtubePlaylist.albumType
                        : searchExtrasRu.youtubePlaylist.playlistType
                }
                title={playlist.title}
                artworkShape="square"
                backgroundImage={artworkUrl}
                description={
                    playlist.description ? <p>{playlist.description}</p> : null
                }
                metadata={
                    <>
                        <span>
                            {formatYouTubePlaylistTrackCount(
                                playlist.trackCount,
                            )}
                        </span>
                        {totalDuration > 0 && (
                            <>
                                <span aria-hidden="true">•</span>
                                <span>
                                    {formatYouTubePlaylistDuration(
                                        totalDuration,
                                    )}
                                </span>
                            </>
                        )}
                    </>
                }
                artwork={
                    artworkUrl ? (
                        <CachedImage
                            src={artworkUrl}
                            alt={playlist.title}
                            fill
                            sizes="(max-width: 640px) 176px, 224px"
                            className="object-cover"
                            unoptimized
                        />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand/20 via-ai/10 to-surface-highlight">
                            <Music2
                                className="h-16 w-16 text-content-muted"
                                aria-hidden="true"
                            />
                        </div>
                    )
                }
                actions={actions}
            />

            <main className="mx-auto max-w-[1800px] px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
                {playlist.tracks.length > 0 ? (
                    <MusicDetailTrackSurface label={`${playlist.title}: треки`}>
                        <BrowseTrackList
                            tracks={playlist.tracks}
                            onPlayTrack={onPlayTrack}
                        />
                    </MusicDetailTrackSurface>
                ) : (
                    <EmptyState
                        icon={<Music2 className="h-7 w-7" aria-hidden="true" />}
                        title={searchExtrasRu.youtubePlaylist.noTracks}
                        description={searchExtrasRu.youtubePlaylist.empty}
                    />
                )}
            </main>
        </div>
    );
}

/**
 * Renders the YtMusicPlaylistDetailPage component.
 */
export default function YtMusicPlaylistDetailPage() {
    return (
        <Suspense fallback={<LoadingScreen message="Загружаем плейлист…" />}>
            <YtMusicPlaylistDetailPageContent />
        </Suspense>
    );
}

function YtMusicPlaylistDetailPageContent() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const playlistId = decodeRouteId(params.id as string);
    const isAlbumType =
        searchParams.get("type") === "album" || playlistId.startsWith("MPREb_");

    // Audio context
    const { currentTrack } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    const { playTracks, playNow, addTracksToQueue, pause, resume } =
        useAudioControls();

    // State
    const [playlist, setPlaylist] = useState<YtMusicBrowsePlaylist | null>(
        null,
    );
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [isAddingToPlaylist, setIsAddingToPlaylist] = useState(false);
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();

    // Fetch playlist data
    useEffect(() => {
        let isActive = true;

        async function fetchPlaylist() {
            setIsLoading(true);
            setError(null);
            setPlaylist(null);

            try {
                const endpoint = isAlbumType
                    ? `/browse/ytmusic/album/${encodeURIComponent(playlistId)}`
                    : `/browse/ytmusic/playlist/${encodeURIComponent(playlistId)}`;
                const data = await api.get<YtMusicBrowsePlaylist>(endpoint);
                if (isActive) {
                    setPlaylist(data);
                }
            } catch (playlistError) {
                if (isNotFoundError(playlistError)) {
                    try {
                        const song = await api.getYtMusicSong(playlistId);
                        if (isActive) {
                            setPlaylist(
                                buildSingleTrackPlaylist(
                                    song as YtMusicSongResponse,
                                    playlistId,
                                ),
                            );
                        }
                        return;
                    } catch {
                        // Fall through and surface the original playlist error below.
                    }
                }

                const message = userFacingError(
                    playlistError,
                    searchExtrasRu.youtubePlaylist.loadFailed,
                );
                if (isActive) {
                    setError(message);
                }
            } finally {
                if (isActive) {
                    setIsLoading(false);
                }
            }
        }

        fetchPlaylist();

        return () => {
            isActive = false;
        };
    }, [playlistId, isAlbumType]);

    // Check if the current queue is this browse playlist
    const isThisPlaylistPlaying =
        currentTrack?.id?.startsWith("yt:") &&
        playlist?.tracks.some((t) => `yt:${t.videoId}` === currentTrack?.id);

    // Play entire playlist
    const handlePlayAll = (startIndex: number = 0) => {
        if (!playlist) return;
        const tracks = playlist.tracks
            .filter((t) => t.videoId)
            .map(browseTrackToQueueTrack);
        if (tracks.length === 0) {
            toast.error(searchExtrasRu.youtubePlaylist.noPlayableTracks);
            return;
        }
        playTracks(tracks, startIndex);
    };

    // Toggle play/pause for header button
    const handleTogglePlay = () => {
        if (isThisPlaylistPlaying && isPlaying) {
            pause();
        } else if (isThisPlaylistPlaying) {
            resume();
        } else {
            triggerPlayFeedback();
            handlePlayAll(0);
        }
    };

    // Likeable tracks for Like All
    const likeableTracks: LikeableTrack[] = useMemo(
        () =>
            (playlist?.tracks || [])
                .filter((t) => t.videoId)
                .map((t) => ({
                    id: `yt:${t.videoId}`,
                    title: t.title,
                    artist: t.artist,
                    album: t.album,
                    duration: t.duration,
                    thumbnailUrl: t.thumbnailUrl || undefined,
                })),
        [playlist?.tracks],
    );
    const {
        isAllLiked,
        isApplying: isApplyingLikeAll,
        toggleLikeAll,
    } = useCollectionLikeAll(likeableTracks);

    // Add all to queue
    const handleAddToQueue = () => {
        if (!playlist) return;
        const tracks = playlist.tracks
            .filter((t) => t.videoId)
            .map(browseTrackToQueueTrack);
        if (tracks.length === 0) return;
        addTracksToQueue(tracks);
        toast.success(formatYouTubeTracksAdded(tracks.length));
    };

    // Shuffle play
    const handleShuffle = () => {
        if (!playlist) return;
        const tracks = playlist.tracks
            .filter((t) => t.videoId)
            .map(browseTrackToQueueTrack);
        if (tracks.length < 2) return;
        playTracks(shuffleArray(tracks), 0);
    };

    // Add all to playlist
    const handlePlaylistSelected = async (playlistId: string) => {
        if (!playlist?.tracks.length) return;
        setIsAddingToPlaylist(true);
        try {
            for (const track of playlist.tracks) {
                if (!track.videoId) continue;
                await api.addTrackToPlaylist(
                    playlistId,
                    toAddToPlaylistRef({
                        id: `yt:${track.videoId}`,
                        title: track.title,
                        artist: track.artist,
                        album: track.album,
                        duration: track.duration,
                        streamSource: "youtube",
                        youtubeVideoId: track.videoId,
                        thumbnailUrl: track.thumbnailUrl || undefined,
                    }),
                );
            }
            toast.success(
                formatYouTubeTracksAddedToPlaylist(playlist.tracks.length),
            );
            setShowPlaylistSelector(false);
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to add tracks to playlist:",
                error,
            );
            toast.error(searchExtrasRu.youtubePlaylist.addSomeToPlaylistFailed);
        } finally {
            setIsAddingToPlaylist(false);
        }
    };

    // Play a specific track — insert next in queue and play immediately
    const handlePlayTrack = (index: number) => {
        if (!playlist) return;
        const track = playlist.tracks[index];
        if (!track?.videoId) return;

        // If clicking the currently playing track, toggle
        if (currentTrack?.id === `yt:${track.videoId}`) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }

        // Insert next in queue and play immediately
        playNow(browseTrackToQueueTrack(track));
    };

    // Total duration
    const totalDuration =
        playlist?.tracks.reduce((sum, track) => sum + track.duration, 0) || 0;
    const providerAlbumEntity =
        isAlbumType && playlist
            ? {
                  type: "album" as const,
                  source: "ytmusic" as const,
                  entityId: playlistId,
                  title: playlist.title,
                  subtitle: playlist.tracks[0]?.artist || null,
                  imageUrl: playlist.thumbnailUrl,
              }
            : null;

    if (isLoading) {
        return <LoadingScreen message="Загружаем плейлист…" />;
    }

    if (error || !playlist) {
        return (
            <main
                role="alert"
                className="flex min-h-screen items-center justify-center bg-surface px-4"
            >
                <EmptyState
                    icon={<Music2 className="h-7 w-7" aria-hidden="true" />}
                    title={searchExtrasRu.youtubePlaylist.notFound}
                    description={
                        error || searchExtrasRu.youtubePlaylist.unavailable
                    }
                    action={{
                        label: searchExtrasRu.youtubePlaylist.explore,
                        onClick: () => router.push("/explore"),
                    }}
                />
            </main>
        );
    }

    return (
        <>
            <YtPlaylistEditorialSurface
                playlist={playlist}
                isAlbumType={isAlbumType}
                totalDuration={totalDuration}
                onPlayTrack={handlePlayTrack}
                actions={
                    <YtPlaylistActionDock
                        tracks={playlist.tracks}
                        collectionId={playlist.id}
                        collectionLabel={playlist.title}
                        isAlbumType={isAlbumType}
                        providerAlbumEntity={providerAlbumEntity}
                        isThisPlaylistPlaying={Boolean(isThisPlaylistPlaying)}
                        isPlaying={isPlaying}
                        showPlaySpinner={showPlaySpinner}
                        likeableTrackCount={likeableTracks.length}
                        isAllLiked={isAllLiked}
                        isApplyingLikeAll={isApplyingLikeAll}
                        onTogglePlay={handleTogglePlay}
                        onShuffle={handleShuffle}
                        onAddToQueue={handleAddToQueue}
                        onAddToPlaylist={() => setShowPlaylistSelector(true)}
                        onToggleLikeAll={() => void toggleLikeAll()}
                        onBack={() => router.back()}
                    />
                }
            />

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => setShowPlaylistSelector(false)}
                onSelectPlaylist={handlePlaylistSelected}
                isLoading={isAddingToPlaylist}
                loadingMessage={searchExtrasRu.youtubePlaylist.addingTracks}
            />
        </>
    );
}
