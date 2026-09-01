"use client";

import { useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
    useAudioState,
    usePlaybackStatus,
    useAudioControls,
} from "@/lib/audio-context";
import { useDownloadContext } from "@/lib/download-context";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ReleaseSelectionModal } from "@/components/ui/ReleaseSelectionModal";
import { useImageColor } from "@/hooks/useImageColor";
import { api, type SavedMusicEntityInput } from "@/lib/api";
import { toast } from "sonner";
import { useListenTogether } from "@/lib/listen-together-context";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { resolvePreferenceTrackId } from "@/lib/trackRef";
import { shuffleArray } from "@/utils/shuffle";
import { Music2 } from "lucide-react";

// Hooks
import { useArtistData } from "@/features/artist/hooks/useArtistData";
import { useArtistAlbumRequests } from "@/features/artist/hooks/useArtistAlbumRequests";
import { useArtistActions } from "@/features/artist/hooks/useArtistActions";
import { useDownloadActions } from "@/features/artist/hooks/useDownloadActions";
import { useYtMusicTopTracks } from "@/features/artist/hooks/useYtMusicTopTracks";
import { useTidalTopTracks } from "@/features/artist/hooks/useTidalTopTracks";
import { useArtistTracks } from "@/features/artist/hooks/useArtistTracks";
import { useProviderArtistTracks } from "@/features/artist/hooks/useProviderArtistTracks";
import { useProviderArtistFallback } from "@/features/artist/hooks/useProviderArtistFallback";
import type { Track, Album } from "@/features/artist/types";

// Components
import { ArtistHero } from "@/features/artist/components/ArtistHero";
import { ArtistActionBar } from "@/features/artist/components/ArtistActionBar";
import { ArtistBio } from "@/features/artist/components/ArtistBio";
import { PopularTracks } from "@/features/artist/components/PopularTracks";
import { Discography } from "@/features/artist/components/Discography";
import { AvailableAlbums } from "@/features/artist/components/AvailableAlbums";
import { SimilarArtists } from "@/features/artist/components/SimilarArtists";
import { ArtistTrackContinuation } from "@/features/artist/components/ArtistTrackContinuation";
import { ProviderAlbumsGrid } from "@/features/search/components/ProviderAlbumsGrid";
import { SaveMusicEntityButton } from "@/features/library/components/SaveMusicEntityButton";
import { DeviceCollectionDownloadButton } from "@/features/device-offline/components/DeviceCollectionDownloadButton";
import {
    ArtistViewTabs,
    buildArtistViewHref,
    resolveArtistView,
} from "@/features/artist/components/ArtistViewTabs";
import {
    filterArtistReleases,
    mergeArtistTracks,
} from "@/features/artist/artistView";
import {
    artistRu,
    formatArtistAlbumPlaying,
    formatArtistRadioPlaying,
    formatArtistSharedRadioMessage,
} from "@/lib/i18n/musicPagesRu";

function ListSectionSkeleton({
    title,
    rows = 5,
}: {
    title: string;
    rows?: number;
}) {
    return (
        <section>
            <h2 className="mb-4 text-2xl font-black tracking-[-0.03em] sm:text-3xl">
                {title}
            </h2>
            <div className="divide-y divide-white/[0.06] border-y border-white/[0.08]">
                {Array.from({ length: rows }).map((_, index) => (
                    <div
                        key={`${title}-row-${index}`}
                        className="h-14 animate-pulse bg-white/[0.035] motion-reduce:animate-none"
                    />
                ))}
            </div>
        </section>
    );
}

function GridSectionSkeleton({
    title,
    columns = 5,
}: {
    title: string;
    columns?: number;
}) {
    return (
        <section>
            <h2 className="mb-5 text-2xl font-black tracking-[-0.03em] sm:text-3xl">
                {title}
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {Array.from({ length: columns }).map((_, index) => (
                    <div
                        key={`${title}-grid-${index}`}
                        className="aspect-square animate-pulse rounded-xl bg-white/5 motion-reduce:animate-none"
                    />
                ))}
            </div>
        </section>
    );
}

function ArtistViewEmptyState({
    title,
    description,
}: {
    title: string;
    description: string;
}) {
    return (
        <div className="border-y border-white/[0.08] px-5 py-14 text-center">
            <h2 className="text-xl font-bold text-white">{title}</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-gray-400">
                {description}
            </p>
        </div>
    );
}

/**
 * Renders the ArtistPage component.
 */
export default function ArtistPage() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const activeView = resolveArtistView(searchParams.get("view"));
    const serializedSearchParams = searchParams.toString();
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    const { playTracks, pause, addTracksToQueue } = useAudioControls();
    const { isPendingByMbid, downloadsEnabled } = useDownloadContext();
    const { isInGroup } = useListenTogether();

    // Data hook
    const {
        artist,
        albums,
        providerAlbums = [],
        artistProvider = null,
        loading,
        detailsLoading,
        error,
        source,
        sortBy,
        setSortBy,
        reloadArtist,
    } = useArtistData();
    const isDirectYtMusicArtist = artistProvider === "ytmusic";
    const libraryArtistTracksEnabled =
        activeView === "tracks" &&
        source === "library" &&
        !isDirectYtMusicArtist;
    const artistTracksQuery = useArtistTracks(
        artist?.id,
        libraryArtistTracksEnabled,
    );
    const shouldResolveProviderFallback =
        source === "library" && Boolean(artist?.name);
    const providerArtistFallback = useProviderArtistFallback(
        artist?.name ?? "",
        shouldResolveProviderFallback,
    );
    const fallbackProviderData = providerArtistFallback.data;
    const providerReleases = isDirectYtMusicArtist
        ? providerAlbums
        : (fallbackProviderData?.providerAlbums ?? []);
    const providerCatalogEnabled =
        activeView === "tracks" &&
        (isDirectYtMusicArtist || Boolean(fallbackProviderData));
    const providerArtistTracksQuery = useProviderArtistTracks(
        providerReleases,
        providerCatalogEnabled,
    );

    const artistAlbumRequests = useArtistAlbumRequests(artist?.name || "");
    const albumRequestControls = {
        enabled: artistAlbumRequests.requestsEnabled,
        isRequestable: artistAlbumRequests.isRequestableAlbum,
        isRequested: artistAlbumRequests.isRequestedAlbum,
        isSubmitting: artistAlbumRequests.isSubmittingRequest,
        request: (album: Album) => void artistAlbumRequests.requestAlbum(album),
    };

    // Action hooks
    const {
        playAll,
        shufflePlay,
        addAllToQueue,
        likeAllTracks,
        addAllToPlaylist,
    } = useArtistActions();
    const { downloadArtist, downloadAlbum } = useDownloadActions();

    // Playlist selector state
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [isAddingToPlaylist, setIsAddingToPlaylist] = useState(false);
    const [isLikingAll, setIsLikingAll] = useState(false);
    const [radioConfirm, setRadioConfirm] = useState<{
        tracks: Track[];
        count: number;
    } | null>(null);
    const radioConfirmedRef = useRef(false);

    // Enrich unowned top tracks with TIDAL streaming, then YT Music for remaining gaps
    const artistWithTopTracks = artist?.topTracks?.length ? artist : null;
    const {
        enrichedTopTracks: tidalEnrichedTopTracks,
        isMatching: isTidalMatching,
        isStatusResolved: isTidalStatusResolved,
    } = useTidalTopTracks(artistWithTopTracks);
    const tidalArtist = artistWithTopTracks
        ? {
              ...artistWithTopTracks,
              topTracks:
                  tidalEnrichedTopTracks || artistWithTopTracks.topTracks,
          }
        : null;
    const {
        enrichedTopTracks,
        isMatching: isYtMatching,
        isStatusResolved: isYtStatusResolved,
    } = useYtMusicTopTracks(tidalArtist);
    const isProviderMatching = isDirectYtMusicArtist
        ? false
        : !isTidalStatusResolved ||
          !isYtStatusResolved ||
          isTidalMatching ||
          isYtMatching;
    const popularTracks = enrichedTopTracks || artist?.topTracks || [];
    const fallbackProviderTracks = fallbackProviderData
        ? mergeArtistTracks(
              fallbackProviderData.artist.topTracks ?? [],
              providerArtistTracksQuery.tracks,
          )
        : [];
    const visibleArtistTracks =
        isDirectYtMusicArtist && activeView === "tracks"
            ? mergeArtistTracks(popularTracks, providerArtistTracksQuery.tracks)
            : libraryArtistTracksEnabled
              ? mergeArtistTracks(
                    popularTracks,
                    mergeArtistTracks(
                        artistTracksQuery.tracks,
                        fallbackProviderTracks,
                    ),
                )
              : source === "library" && fallbackProviderTracks.length > 0
                ? mergeArtistTracks(popularTracks, fallbackProviderTracks)
                : popularTracks;
    const isArtistTracksLoading =
        visibleArtistTracks.length === 0 &&
        ((libraryArtistTracksEnabled && artistTracksQuery.isLoading) ||
            (isDirectYtMusicArtist &&
                activeView === "tracks" &&
                (providerArtistTracksQuery.isLoading ||
                    providerArtistTracksQuery.hasNextPage)) ||
            (shouldResolveProviderFallback &&
                (providerArtistFallback.isLoading ||
                    (providerCatalogEnabled &&
                        (providerArtistTracksQuery.isLoading ||
                            providerArtistTracksQuery.hasNextPage)))));

    // Separate owned and available albums
    const ownedAlbums = albums.filter((a) => a.owned);
    const availableAlbums = albums.filter((a) => !a.owned);
    const visibleOwnedAlbums = filterArtistReleases(ownedAlbums, activeView);
    const visibleAvailableAlbums = filterArtistReleases(
        availableAlbums,
        activeView,
    );
    const visibleProviderAlbums = providerReleases.filter((release) => {
        const isSingle = /(?:single|ep)/i.test(release.releaseType ?? "");
        if (activeView === "singles") return isSingle;
        if (activeView === "albums") return !isSingle;
        return true;
    });
    const showTracks = activeView === "overview" || activeView === "tracks";
    const showReleases =
        activeView === "overview" ||
        activeView === "albums" ||
        activeView === "singles";
    const hasVisibleReleases =
        visibleOwnedAlbums.length > 0 ||
        visibleAvailableAlbums.length > 0 ||
        visibleProviderAlbums.length > 0;

    // Get image URLs for display and color extraction
    const rawImageUrl =
        artist && source === "library"
            ? artist.coverArt
            : artist?.image || null;

    // Use a high-res image for the hero section
    const heroImage = rawImageUrl
        ? api.getCoverArtUrl(rawImageUrl, 1200)
        : null;

    // Use a low-res image for color extraction and background blur to save CPU
    // Include token for CORS access needed by canvas color extraction
    const lowResImage = rawImageUrl
        ? api.getCoverArtUrl(rawImageUrl, 300, true)
        : null;

    const { colors } = useImageColor(lowResImage || rawImageUrl);

    const savedArtistEntity: SavedMusicEntityInput | null = artist
        ? {
              type: "artist",
              source: isDirectYtMusicArtist
                  ? "ytmusic"
                  : source === "library"
                    ? "library"
                    : "discovery",
              entityId:
                  isDirectYtMusicArtist && artist.id.startsWith("ytartist:")
                      ? artist.id.slice("ytartist:".length)
                      : artist.id,
              title: artist.name,
              subtitle: null,
              imageUrl: rawImageUrl ?? null,
          }
        : null;

    const isLibraryArtist = source === "library";
    const showProgressivePlaceholders = isLibraryArtist && detailsLoading;

    // Play album handler
    async function handlePlayAlbum(albumId: string, albumTitle: string) {
        try {
            const albumData = await api.getAlbum(albumId);
            if (albumData.tracks && albumData.tracks.length > 0) {
                const tracksWithAlbum = albumData.tracks.map(
                    (track: Record<string, unknown>) => ({
                        ...track,
                        album: {
                            id: albumData.id,
                            title: albumData.title,
                            coverArt: albumData.coverArt,
                        },
                        artist: albumData.artist,
                    }),
                );
                playTracks(tracksWithAlbum, 0);
                toast.success(formatArtistAlbumPlaying(albumTitle));
            }
        } catch {
            toast.error(artistRu.playAlbumFailed);
        }
    }

    const formatTrackForPlayback = (t: Track) => ({
        id: resolvePreferenceTrackId({
            ...t,
            hasLocalFile:
                typeof t.filePath === "string" && t.filePath.trim().length > 0,
        }),
        title: t.title,
        artist: {
            name: t.artist?.name || artist!.name,
            id: t.artist?.id || artist!.id,
        },
        album: {
            title: t.album?.title || artistRu.unknownAlbum,
            coverArt: t.album?.coverArt,
            id: t.album?.id,
        },
        duration: t.duration,
        filePath: t.filePath,
        source: t.source,
        peer: t.peer,
        ...(t.streamSource === "tidal" && {
            streamSource: "tidal" as const,
            tidalTrackId: t.tidalTrackId,
        }),
        ...(t.streamSource === "youtube" && {
            streamSource: "youtube" as const,
            youtubeVideoId: t.youtubeVideoId,
        }),
        ...(t.streamSource === "peer" && {
            streamSource: "peer" as const,
        }),
    });
    const deviceDownloadTracks = visibleArtistTracks
        .filter(
            (track: Track) =>
                Boolean(track.filePath) ||
                (track.streamSource === "tidal" &&
                    typeof track.tidalTrackId === "number") ||
                (track.streamSource === "youtube" &&
                    Boolean(track.youtubeVideoId)),
        )
        .map(formatTrackForPlayback);
    const hasProviderTrackContext =
        isDirectYtMusicArtist || fallbackProviderTracks.length > 0;

    function handlePlayProviderArtist(shuffle: boolean) {
        if (!artist) return;
        const playableTracks = visibleArtistTracks.filter(
            (track: Track) =>
                track.streamSource === "youtube" && !!track.youtubeVideoId,
        );
        if (playableTracks.length === 0) {
            toast.error(artistRu.noPlayableTracks);
            return;
        }
        const orderedTracks = shuffle
            ? shuffleArray(playableTracks)
            : playableTracks;
        playTracks(orderedTracks.map(formatTrackForPlayback), 0);
    }

    // A row click starts the artist's ordered popular-track context. This
    // keeps the following track predictable; provider radio can extend the
    // queue only after the visible artist context has been consumed.
    function handlePlayTrack(
        track: Track,
        _index: number,
        visibleTracks: Track[],
    ) {
        if (!artist) return;
        const contextTracks = visibleTracks.filter(
            (candidate: Track) =>
                (candidate.source === "federated" &&
                    candidate.peer?.online === true) ||
                Boolean(candidate.filePath) ||
                (candidate.streamSource === "tidal" &&
                    Boolean(candidate.tidalTrackId)) ||
                (candidate.streamSource === "youtube" &&
                    Boolean(candidate.youtubeVideoId)),
        );
        const selectedIndex = contextTracks.indexOf(track);
        if (selectedIndex < 0) return;
        playTracks(contextTracks.map(formatTrackForPlayback), selectedIndex);
    }

    function handleAddAllPopularToQueue(visibleTracks: Track[]) {
        const playable = visibleTracks.filter(
            (t) =>
                t.filePath ||
                (t.streamSource === "tidal" && t.tidalTrackId) ||
                (t.streamSource === "youtube" && t.youtubeVideoId),
        );
        if (!playable.length) return;
        const formattedTracks = playable.map(formatTrackForPlayback);
        addTracksToQueue(formattedTracks);
    }

    // Download album handler
    function handleDownloadAlbum(album: Album, e: React.MouseEvent) {
        downloadAlbum(album, artist?.name || "", e);
    }

    const [searchAlbum, setSearchAlbum] = useState<Album | null>(null);
    function handleSearchAlbum(album: Album, e: React.MouseEvent) {
        e.preventDefault();
        e.stopPropagation();
        setSearchAlbum(album);
    }

    // Like all artist tracks (one-way action with spinner)
    async function handleLikeAll() {
        if (!artist) return;
        setIsLikingAll(true);
        try {
            await likeAllTracks(artist, albums);
        } finally {
            setIsLikingAll(false);
        }
    }

    // Add all to playlist handler — keeps modal open on failure
    async function handlePlaylistSelected(playlistId: string) {
        if (!artist) return;
        setIsAddingToPlaylist(true);
        try {
            await addAllToPlaylist(artist, albums, playlistId);
        } finally {
            setIsAddingToPlaylist(false);
        }
    }

    // Start artist radio handler
    async function handleStartRadio() {
        if (!artist) return;

        try {
            toast.success(artistRu.radioStarting);
            const response = await api.getRadioTracks("artist", artist.id);

            if (response.tracks && response.tracks.length > 0) {
                if (isInGroup) {
                    setRadioConfirm({
                        tracks: response.tracks,
                        count: response.tracks.length,
                    });
                    return;
                }

                // Backend already returns properly formatted tracks - just pass them through
                playTracks(response.tracks, 0);
                toast.success(
                    formatArtistRadioPlaying(
                        artist.name,
                        response.tracks.length,
                    ),
                );
            } else {
                toast.error(artistRu.radioNotEnough);
            }
        } catch {
            toast.error(artistRu.radioStartFailed);
        }
    }

    const handleConfirmRadio = () => {
        if (!radioConfirm) return;
        radioConfirmedRef.current = true;
        playTracks(radioConfirm.tracks as Parameters<typeof playTracks>[0], 0);
        toast.success(
            formatArtistRadioPlaying(
                artist?.name ?? artistRu.fallbackName,
                radioConfirm.count,
            ),
        );
    };

    const handleCloseRadioConfirm = () => {
        if (!radioConfirmedRef.current) {
            toast.info(artistRu.radioCancelled);
        }
        radioConfirmedRef.current = false;
        setRadioConfirm(null);
    };

    // Loading state for initial/core request only
    if (loading) {
        return <LoadingScreen message={artistRu.loading} />;
    }

    // Error or not found state
    if (error || !artist) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center space-y-4">
                    <Music2
                        className="mx-auto h-14 w-14 text-white/20"
                        aria-hidden="true"
                    />
                    <h1 className="text-2xl font-semibold text-white">
                        {artistRu.notFound}
                    </h1>
                    <p className="text-neutral-400">
                        {artistRu.notFoundDescription}
                    </p>
                    <button
                        onClick={() => router.back()}
                        className="min-h-11 rounded-lg bg-neutral-800 px-4 py-2 text-white transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                    >
                        {artistRu.goBack}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div
            data-artist-page-canvas="open"
            className="flex min-h-screen flex-col"
        >
            <ArtistHero
                artist={artist}
                source={source || "discovery"}
                albums={albums}
                heroImage={heroImage}
                backgroundImage={lowResImage}
                colors={colors}
                onReload={reloadArtist}
            >
                {/* Action bar inside hero for visual continuity */}
                <ArtistActionBar
                    artist={artist}
                    albums={albums}
                    source={source || "discovery"}
                    colors={colors}
                    onPlayAll={() =>
                        hasProviderTrackContext
                            ? handlePlayProviderArtist(false)
                            : playAll(artist, albums)
                    }
                    onAddAllToQueue={() =>
                        hasProviderTrackContext
                            ? handleAddAllPopularToQueue(visibleArtistTracks)
                            : addAllToQueue(artist, albums)
                    }
                    onShuffle={() =>
                        hasProviderTrackContext
                            ? handlePlayProviderArtist(true)
                            : shufflePlay(artist, albums)
                    }
                    onDownloadAll={() => downloadArtist(artist)}
                    onStartRadio={handleStartRadio}
                    onAddToPlaylist={
                        source === "library"
                            ? () => setShowPlaylistSelector(true)
                            : undefined
                    }
                    onLikeAll={source === "library" ? handleLikeAll : undefined}
                    isLikingAll={isLikingAll}
                    isPendingDownload={isPendingByMbid(artist.mbid || "")}
                    isPlaying={isPlaying}
                    isPlayingThisArtist={
                        currentTrack?.artist?.id === artist.id ||
                        currentTrack?.artist?.name === artist.name
                    }
                    onPause={pause}
                    downloadsEnabled={
                        downloadsEnabled && !isDirectYtMusicArtist
                    }
                    isInListenTogetherGroup={isInGroup}
                    librarySaveControl={
                        <SaveMusicEntityButton entity={savedArtistEntity} />
                    }
                    deviceDownloadControl={
                        deviceDownloadTracks.length > 0 ? (
                            <DeviceCollectionDownloadButton
                                tracks={deviceDownloadTracks}
                                collectionId={`artist:${artist.id}`}
                                collectionLabel={artist.name}
                            />
                        ) : undefined
                    }
                />
            </ArtistHero>

            <div className="relative min-h-[50vh] flex-1 bg-surface">
                <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-80 opacity-70"
                    style={{
                        background: colors
                            ? `linear-gradient(to bottom, ${colors.vibrant}1f 0%, ${colors.darkVibrant}0d 52%, transparent 100%)`
                            : "linear-gradient(to bottom, color-mix(in srgb, var(--music-action) 8%, transparent), transparent)",
                    }}
                />

                <div className="relative mx-auto w-full max-w-[1600px] space-y-10 px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
                    <div className="sticky top-2 z-20 -mx-1 border-y border-white/[0.08] bg-surface/85 px-1 py-2 backdrop-blur-xl">
                        <ArtistViewTabs
                            activeView={activeView}
                            pathname={pathname}
                            searchParams={serializedSearchParams}
                        />
                    </div>

                    {/* Popular Tracks */}
                    {showTracks && visibleArtistTracks.length > 0 ? (
                        <PopularTracks
                            tracks={visibleArtistTracks}
                            artist={artist}
                            currentTrackId={currentTrack?.id}
                            colors={colors}
                            onPlayTrack={handlePlayTrack}
                            isProviderMatching={
                                isProviderMatching &&
                                !libraryArtistTracksEnabled
                            }
                            popularHref={
                                activeView === "overview"
                                    ? buildArtistViewHref(
                                          pathname,
                                          serializedSearchParams,
                                          "tracks",
                                      )
                                    : undefined
                            }
                            onAddAllToQueue={handleAddAllPopularToQueue}
                            showAll={activeView === "tracks"}
                        />
                    ) : showTracks &&
                      (showProgressivePlaceholders || isArtistTracksLoading) ? (
                        <ListSectionSkeleton title={artistRu.popular} />
                    ) : showTracks && activeView === "tracks" ? (
                        <ArtistViewEmptyState
                            title={artistRu.noTracks}
                            description={artistRu.noTracksDescription}
                        />
                    ) : null}

                    {activeView === "tracks" ? (
                        <ArtistTrackContinuation
                            visibleTrackCount={visibleArtistTracks.length}
                            library={
                                libraryArtistTracksEnabled &&
                                artistTracksQuery.hasNextPage
                                    ? {
                                          loaded: artistTracksQuery.tracks
                                              .length,
                                          total: artistTracksQuery.total,
                                          isFetching:
                                              artistTracksQuery.isFetchingNextPage,
                                          loadMore: () =>
                                              artistTracksQuery.fetchNextPage(),
                                      }
                                    : undefined
                            }
                            provider={
                                providerCatalogEnabled &&
                                providerArtistTracksQuery.hasNextPage
                                    ? {
                                          loadedReleases:
                                              providerArtistTracksQuery.loadedReleaseCount,
                                          totalReleases:
                                              providerArtistTracksQuery.totalReleaseCount,
                                          isFetching:
                                              providerArtistTracksQuery.isFetchingNextPage,
                                          loadMore: () =>
                                              providerArtistTracksQuery.fetchNextPage(),
                                      }
                                    : undefined
                            }
                        />
                    ) : null}

                    {showReleases &&
                        (activeView === "albums" || activeView === "singles") &&
                        !detailsLoading &&
                        !hasVisibleReleases && (
                            <ArtistViewEmptyState
                                title={
                                    activeView === "singles"
                                        ? artistRu.noSingles
                                        : artistRu.noAlbums
                                }
                                description={artistRu.noReleasesDescription}
                            />
                        )}

                    {activeView === "overview" &&
                        (artist.bio || artist.summary) && (
                            <ArtistBio
                                bio={artist.bio || artist.summary || ""}
                            />
                        )}

                    {showReleases && visibleOwnedAlbums.length > 0 && (
                        <Discography
                            albums={visibleOwnedAlbums}
                            colors={colors}
                            onPlayAlbum={handlePlayAlbum}
                            sortBy={sortBy}
                            onSortChange={setSortBy}
                            title={
                                activeView === "singles"
                                    ? artistRu.singlesAndEps
                                    : artistRu.discography
                            }
                        />
                    )}

                    {showReleases && visibleProviderAlbums.length > 0 && (
                        <section>
                            <h2 className="mb-5 text-2xl font-black tracking-[-0.03em] sm:text-3xl">
                                {activeView === "singles"
                                    ? artistRu.singlesAndEps
                                    : artistRu.albums}
                            </h2>
                            <ProviderAlbumsGrid
                                albums={visibleProviderAlbums}
                                limit={null}
                            />
                        </section>
                    )}

                    {/* Available Albums to Download */}
                    {showReleases && visibleAvailableAlbums.length > 0 ? (
                        <AvailableAlbums
                            albums={visibleAvailableAlbums}
                            artistName={artist.name}
                            source={source || "discovery"}
                            colors={colors}
                            onDownloadAlbum={handleDownloadAlbum}
                            onSearchAlbum={handleSearchAlbum}
                            isPendingDownload={isPendingByMbid}
                            downloadsEnabled={downloadsEnabled}
                            requestControls={albumRequestControls}
                        />
                    ) : showReleases && showProgressivePlaceholders ? (
                        <GridSectionSkeleton title={artistRu.albumsAvailable} />
                    ) : null}

                    {/* Similar Artists */}
                    {activeView === "overview" &&
                    artist.similarArtists &&
                    artist.similarArtists.length > 0 ? (
                        <SimilarArtists
                            similarArtists={artist.similarArtists}
                            onNavigate={(artistId) =>
                                router.push(`/artist/${artistId}`)
                            }
                        />
                    ) : activeView === "overview" &&
                      showProgressivePlaceholders ? (
                        <GridSectionSkeleton title={artistRu.fansAlsoLike} />
                    ) : null}
                </div>
            </div>

            {searchAlbum && (
                <ReleaseSelectionModal
                    isOpen={Boolean(searchAlbum)}
                    onClose={() => setSearchAlbum(null)}
                    albumMbid={
                        searchAlbum.rgMbid || searchAlbum.mbid || searchAlbum.id
                    }
                    artistName={artist.name}
                    albumTitle={searchAlbum.title}
                />
            )}

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => setShowPlaylistSelector(false)}
                onSelectPlaylist={handlePlaylistSelected}
                isLoading={isAddingToPlaylist}
                loadingMessage={artistRu.addingTracks}
            />

            <ConfirmDialog
                isOpen={radioConfirm !== null}
                onClose={handleCloseRadioConfirm}
                onConfirm={handleConfirmRadio}
                title={artistRu.sharedQueueTitle}
                message={formatArtistSharedRadioMessage(
                    radioConfirm?.count ?? 0,
                )}
                confirmText={artistRu.continue}
                cancelText={artistRu.cancel}
                variant="info"
            />
        </div>
    );
}
