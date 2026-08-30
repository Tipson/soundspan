"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    useAudioState,
    usePlaybackStatus,
    useAudioControls,
} from "@/lib/audio-context";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useImageColor } from "@/hooks/useImageColor";
import { api, type SavedMusicEntityInput } from "@/lib/api";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useDownloadContext } from "@/lib/download-context";
import { useListenTogether } from "@/lib/listen-together-context";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

// Custom hooks
import { useAlbumData } from "@/features/album/hooks/useAlbumData";
import {
    useAlbumActions,
    useAlbumLikedState,
} from "@/features/album/hooks/useAlbumActions";
import { useAlbumRequest } from "@/features/album/hooks/useAlbumRequest";
import { useTrackDeepLink } from "@/features/album/hooks/useTrackDeepLink";
import { useYtMusicGapFill } from "@/features/album/hooks/useYtMusicGapFill";
import { useTidalGapFill } from "@/features/album/hooks/useTidalGapFill";
import { useTrackPreview } from "@/hooks/useTrackPreview";
import type { Track as AlbumTrack } from "@/features/album/types";
import { toAddToPlaylistRef, type AddToPlaylistRef } from "@/lib/trackRef";

// Components
import { AlbumHero } from "@/features/album/components/AlbumHero";
import { AlbumActionBar } from "@/features/album/components/AlbumActionBar";
import { TrackList } from "@/features/album/components/TrackList";
import { SimilarAlbums } from "@/features/album/components/SimilarAlbums";
import { SaveMusicEntityButton } from "@/features/library/components/SaveMusicEntityButton";
import { DeviceCollectionDownloadButton } from "@/features/device-offline/components/DeviceCollectionDownloadButton";
import { toAlbumPlaybackTrack } from "@/features/album/albumPlayback";

interface AlbumPageProps {
    params: Promise<{
        id: string;
    }>;
}

function AlbumTracksSkeleton() {
    return (
        <section>
            <div className="rounded-xl border border-white/10 bg-[#111111]/60 overflow-hidden">
                <div className="space-y-2 p-4 md:p-5">
                    {Array.from({ length: 8 }).map((_, index) => (
                        <div
                            key={index}
                            className="h-12 animate-pulse rounded-lg bg-white/[0.07]"
                        />
                    ))}
                </div>
            </div>
        </section>
    );
}

/**
 * Renders the AlbumPage component.
 */
export default function AlbumPage({ params }: AlbumPageProps) {
    const { id } = use(params);
    const router = useRouter();
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    const { pause } = useAudioControls();
    const { isInGroup } = useListenTogether();

    // State
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [pendingTrackRefs, setPendingTrackRefs] = useState<
        AddToPlaylistRef[]
    >([]);
    const [, setIsBulkAdd] = useState(false);
    const [, setIsAddingToPlaylist] = useState(false);
    const [libraryDeletionAllowed, setLibraryDeletionAllowed] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isDeletingAlbum, setIsDeletingAlbum] = useState(false);

    // Custom hooks
    const {
        album: rawAlbum,
        source,
        loading,
        detailsLoading,
        reloadAlbum,
    } = useAlbumData(id);
    const {
        enrichedTracks: tidalEnrichedTracks,
        isMatching: isTidalMatching,
        isStatusResolved: isTidalStatusResolved,
    } = useTidalGapFill(rawAlbum, source ?? undefined);
    const tidalAlbum = rawAlbum
        ? { ...rawAlbum, tracks: tidalEnrichedTracks || rawAlbum.tracks }
        : rawAlbum;
    const {
        enrichedTracks,
        isMatching: isYtMatching,
        isStatusResolved: isYtStatusResolved,
    } = useYtMusicGapFill(tidalAlbum, source);
    const {
        playAlbum,
        shufflePlay,
        addAllToQueue,
        downloadAlbum,
        setAlbumPreference,
        isApplyingAlbumPreference,
    } = useAlbumActions();
    const { isPendingByMbid, downloadsEnabled } = useDownloadContext();
    const { previewTrack, previewPlaying, handlePreview } = useTrackPreview();
    const {
        requestsEnabled,
        isRequestedAlbum,
        isSubmittingRequest,
        requestAlbum,
    } = useAlbumRequest(rawAlbum);

    // Use enriched tracks (with TIDAL + YT Music gap-fill) when available
    const album = rawAlbum
        ? { ...rawAlbum, tracks: enrichedTracks || rawAlbum.tracks }
        : rawAlbum;
    const isAlbumLiked = useAlbumLikedState(album);
    const savedAlbumEntity: SavedMusicEntityInput | null = album
        ? {
              type: "album",
              source:
                  source === "library"
                      ? "library"
                      : source === "remote"
                        ? "remote"
                        : "discovery",
              entityId: album.id,
              title: album.title,
              subtitle: album.artist?.name ?? null,
              imageUrl: album.coverUrl || album.coverArt || null,
          }
        : null;
    const isProviderMatching =
        !isTidalStatusResolved ||
        !isYtStatusResolved ||
        isTidalMatching ||
        isYtMatching;
    const canDeleteFromLibrary = source === "library" && libraryDeletionAllowed;
    const hasTracks = Boolean(album?.tracks && album.tracks.length > 0);
    const deviceDownloadTracks = (album?.tracks ?? [])
        .filter((track: AlbumTrack) => {
            const hasLocalSource = source === "library";
            const hasTidalSource =
                track.streamSource === "tidal" &&
                typeof track.tidalTrackId === "number";
            const hasYouTubeSource =
                track.streamSource === "youtube" &&
                Boolean(track.youtubeVideoId);
            return hasLocalSource || hasTidalSource || hasYouTubeSource;
        })
        .map((track: AlbumTrack) => toAlbumPlaybackTrack(track, album!));
    const showTrackPlaceholder = detailsLoading && !hasTracks;
    const { highlightTrackId } = useTrackDeepLink(
        album,
        (_track, index) => playAlbum(album!, index),
        hasTracks,
    );

    useEffect(() => {
        let cancelled = false;

        if (source !== "library") {
            return () => {
                cancelled = true;
            };
        }

        void api
            .getLibraryDeletePolicy()
            .then((policy) => {
                if (!cancelled) setLibraryDeletionAllowed(policy.canDelete);
            })
            .catch((error) => {
                sharedFrontendLogger.warn(
                    "Failed to load library deletion policy:",
                    error,
                );
                if (!cancelled) setLibraryDeletionAllowed(false);
            });

        return () => {
            cancelled = true;
        };
    }, [source]);

    // Get cover URL for display and color extraction
    // Proxy through API to handle native: URLs and CORS
    const rawCoverUrl =
        album?.coverUrl || album?.coverArt || "/placeholder-album.png";
    const coverUrl =
        rawCoverUrl === "/placeholder-album.png"
            ? rawCoverUrl
            : api.getCoverArtUrl(rawCoverUrl, 1200);
    // Separate URL with token for color extraction (CORS access for canvas)
    const colorExtractionUrl =
        rawCoverUrl === "/placeholder-album.png"
            ? rawCoverUrl
            : api.getCoverArtUrl(rawCoverUrl, 300, true);

    // Extract colors
    const { colors } = useImageColor(colorExtractionUrl);

    // Loading and error states
    if (loading) {
        return <LoadingScreen />;
    }

    if (!album) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center">
                    <h1 className="text-2xl font-bold mb-4">
                        Error Loading Album
                    </h1>
                    <p className="text-gray-400 mb-4">Album not found</p>
                    <button
                        onClick={() => router.push("/albums")}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                    >
                        Back to Albums
                    </button>
                </div>
            </div>
        );
    }

    // Event handlers
    const handlePlayTrack = (_track: AlbumTrack, index: number) => {
        playAlbum(album, index);
    };

    const openPlaylistSelector = (
        trackRefs: AddToPlaylistRef[],
        bulk = false,
    ) => {
        if (!trackRefs.length) return;
        setPendingTrackRefs(trackRefs);
        setIsBulkAdd(bulk);
        setShowPlaylistSelector(true);
    };

    const handleAddAlbumToPlaylist = () => {
        if (!album?.tracks?.length) return;
        const trackRefs = album.tracks.map((track: AlbumTrack) =>
            toAddToPlaylistRef(track),
        );
        openPlaylistSelector(trackRefs, true);
    };

    const handlePlaylistSelected = async (playlistId: string) => {
        if (!pendingTrackRefs.length) return;

        try {
            setIsAddingToPlaylist(true);
            for (const trackRef of pendingTrackRefs) {
                await api.addTrackToPlaylist(playlistId, trackRef);
            }
            setPendingTrackRefs([]);
            setIsBulkAdd(false);
            setShowPlaylistSelector(false);
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to add track(s) to playlist:",
                error,
            );
        } finally {
            setIsAddingToPlaylist(false);
        }
    };

    const handleDeleteAlbum = async () => {
        if (isDeletingAlbum || !canDeleteFromLibrary || source !== "library") {
            return;
        }

        setIsDeletingAlbum(true);
        try {
            if (currentTrack?.album?.id === album.id) pause();
            const result = await api.deleteAlbum(album.id);
            toast.success(result.message || `Deleted “${album.title}”`);
            router.replace("/library?tab=albums");
        } catch (error) {
            sharedFrontendLogger.error("Failed to delete album:", error);
            toast.error("Could not delete this album. Please try again.");
        } finally {
            setIsDeletingAlbum(false);
        }
    };

    return (
        <div className="flex min-h-screen flex-col pb-32 md:pb-24">
            <AlbumHero
                album={album}
                source={source || "discovery"}
                coverUrl={coverUrl}
                colors={colors}
                onReload={reloadAlbum}
            >
                <AlbumActionBar
                    album={album}
                    source={source || "discovery"}
                    colors={colors}
                    onPlayAll={() => {
                        if (!hasTracks) return;
                        playAlbum(album, 0);
                    }}
                    onAddAllToQueue={() => {
                        if (!hasTracks) return;
                        addAllToQueue(album);
                    }}
                    onShuffle={() => {
                        if (!hasTracks) return;
                        shufflePlay(album);
                    }}
                    onDownloadAlbum={() => downloadAlbum(album)}
                    onAddToPlaylist={handleAddAlbumToPlaylist}
                    onToggleAlbumLike={() => {
                        if (!hasTracks) return;
                        void setAlbumPreference(
                            album,
                            isAlbumLiked ? "clear" : "thumbs_up",
                        );
                    }}
                    isAlbumLiked={isAlbumLiked}
                    isPendingDownload={isPendingByMbid(
                        album?.mbid || album?.rgMbid || "",
                    )}
                    isApplyingAlbumPreference={isApplyingAlbumPreference}
                    isPlaying={isPlaying}
                    isPlayingThisAlbum={currentTrack?.album?.id === album.id}
                    onPause={pause}
                    downloadsEnabled={downloadsEnabled}
                    requestsEnabled={requestsEnabled}
                    isRequestedAlbum={isRequestedAlbum}
                    isSubmittingRequest={isSubmittingRequest}
                    onRequestAlbum={() => void requestAlbum()}
                    isInListenTogetherGroup={isInGroup}
                    canDeleteFromLibrary={canDeleteFromLibrary}
                    onDeleteAlbum={() => setShowDeleteConfirm(true)}
                    librarySaveControl={
                        <SaveMusicEntityButton entity={savedAlbumEntity} />
                    }
                    deviceDownloadControl={
                        <DeviceCollectionDownloadButton
                            tracks={deviceDownloadTracks}
                            collectionId={`album:${album.id}`}
                            collectionLabel={album.title}
                        />
                    }
                />
            </AlbumHero>

            <div className="relative min-h-[50vh] flex-1 bg-surface">
                <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-80 opacity-70"
                    style={{
                        background: colors
                            ? `linear-gradient(180deg, ${colors.vibrant}1f 0%, ${colors.darkVibrant}0d 52%, transparent 100%)`
                            : "linear-gradient(180deg, color-mix(in srgb, var(--music-action) 8%, transparent), transparent)",
                    }}
                />
                <div className="relative mx-auto w-full max-w-[1800px] space-y-10 px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
                    {hasTracks && (
                        <TrackList
                            tracks={album.tracks}
                            album={album}
                            source={source || "discovery"}
                            currentTrackId={currentTrack?.id}
                            colors={colors}
                            onPlayTrack={handlePlayTrack}
                            previewTrack={previewTrack}
                            previewPlaying={previewPlaying}
                            onPreview={(
                                track: AlbumTrack,
                                e: React.MouseEvent,
                            ) =>
                                handlePreview(
                                    track,
                                    album.artist?.name || "",
                                    e,
                                )
                            }
                            isProviderMatching={isProviderMatching}
                            highlightTrackId={highlightTrackId}
                        />
                    )}
                    {showTrackPlaceholder && <AlbumTracksSkeleton />}

                    {album.similarAlbums && album.similarAlbums.length > 0 && (
                        <SimilarAlbums
                            similarAlbums={album.similarAlbums}
                            colors={colors}
                            onNavigate={(id) => router.push(`/album/${id}`)}
                        />
                    )}
                </div>
            </div>

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => {
                    setShowPlaylistSelector(false);
                    setPendingTrackRefs([]);
                    setIsBulkAdd(false);
                }}
                onSelectPlaylist={handlePlaylistSelected}
            />
            <ConfirmDialog
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={() => void handleDeleteAlbum()}
                title="Delete album from server?"
                message={`This permanently removes “${album.title}” and its audio files from the server library. This cannot be undone.`}
                confirmText={isDeletingAlbum ? "Deleting…" : "Delete album"}
                variant="danger"
            />
        </div>
    );
}
