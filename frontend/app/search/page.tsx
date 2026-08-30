"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useSearchData } from "@/features/search/hooks/useSearchData";
import { dedupeDiscoverTracks } from "@/features/search/songDedup";
import { mergeSearchAlbums } from "@/features/search/albumDedup";
import { useSoulseekSearch } from "@/features/search/hooks/useSoulseekSearch";
import { useYouTubeUrl } from "@/features/search/hooks/useYouTubeUrl";
import { YouTubePreviewCard } from "@/features/search/components/YouTubePreviewCard";
import { useYouTubePlaylist } from "@/features/search/hooks/useYouTubePlaylist";
import { YouTubePlaylistPreviewCard } from "@/features/search/components/YouTubePlaylistPreviewCard";
import { SearchFilters } from "@/features/search/components/SearchFilters";
import { SearchSectionHeader } from "@/features/search/components/SearchSectionHeader";
import { SearchArtistsGrid } from "@/features/search/components/SearchArtistsGrid";
import { TopResult } from "@/features/search/components/TopResult";
import { EmptyState } from "@/features/search/components/EmptyState";
import { LibraryAlbumsGrid } from "@/features/search/components/LibraryAlbumsGrid";
import { LibraryTracksList } from "@/features/search/components/LibraryTracksList";
import { SimilarArtistsGrid } from "@/features/search/components/SimilarArtistsGrid";
import { DiscoverTracksList } from "@/features/search/components/DiscoverTracksList";
import { ProviderAlbumsGrid } from "@/features/search/components/ProviderAlbumsGrid";
import {
    deriveDiscoverySelection,
    hasCanonicalProviderArtistIdentity,
    isExactArtistSearchMatch,
    normalizeArtistName,
} from "@/features/search/discoverySelection";
import { AliasResolutionBanner } from "@/features/search/components/AliasResolutionBanner";
import { SoulseekSongsList } from "@/features/search/components/SoulseekSongsList";
import { TVSearchInput } from "@/features/search/components/TVSearchInput";
import { useAuth } from "@/lib/auth-context";
import type { SearchResultView } from "@/features/search/types";
import {
    allocateSearchResultLimits,
    hasVisibleTrackResults,
    resolveSearchCatalogPolicy,
    resolvePrimarySongsSurface,
    shouldShowSearchLoadingState,
} from "@/features/search/searchSongsPriority";

type SearchSectionView = Exclude<SearchResultView, "all"> | null;

/** Render one music-first search with entity-scoped result views. */
export default function SearchPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const { user } = useAuth();
    const canDownloadYouTube = user?.role === "admin";
    const query = searchParams.get("q") ?? "";
    const viewParam = searchParams.get("view");
    const sectionView: SearchSectionView =
        viewParam === "tracks" ||
        viewParam === "albums" ||
        viewParam === "artists"
            ? viewParam
            : null;
    const activeView: SearchResultView = sectionView ?? "all";
    const isTracksView = sectionView === "tracks";
    const isAlbumsView = sectionView === "albums";
    const isArtistsView = sectionView === "artists";
    const showTracksView = sectionView === null || isTracksView;
    const sectionViewLinks = {
        tracks: `/search?q=${encodeURIComponent(query)}&view=tracks`,
        albums: `/search?q=${encodeURIComponent(query)}&view=albums`,
        artists: `/search?q=${encodeURIComponent(query)}&view=artists`,
    };
    const searchCatalogPolicy = resolveSearchCatalogPolicy({
        isTracksView,
        isAlbumsView,
        isArtistsView,
    });

    const {
        libraryResults,
        discoverResults,
        similarArtists,
        aliasInfo,
        isLibrarySearching,
        isDiscoverSearching,
        hasSearched,
    } = useSearchData({
        query,
        libraryType: searchCatalogPolicy.libraryType,
        discoverType: searchCatalogPolicy.discoverType,
        libraryLimit: searchCatalogPolicy.libraryLimit,
        discoverLimit: searchCatalogPolicy.discoverLimit,
        similarArtistsLimit: isArtistsView ? 50 : 6,
        source: "all",
    });
    const {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling,
        downloadingFiles,
        handleDownload,
    } = useSoulseekSearch({ query: showTracksView ? query : "" });
    const {
        videoInfo,
        isLoading: isYtLoading,
        isDownloading,
        downloadProgress,
        handlePlay: handleYtPlay,
        handleDownload: handleYtDownload,
    } = useYouTubeUrl({ query });
    const {
        playlistInfo: ytPlaylistInfo,
        isLoading: isYtPlaylistLoading,
        error: ytPlaylistError,
        isDownloading: isYtPlaylistDownloading,
        progress: ytPlaylistProgress,
        handleDownloadAll: handleYtDownloadAll,
        handleCancel: handleYtPlaylistCancel,
    } = useYouTubePlaylist({ query });

    const libraryArtists = libraryResults?.artists ?? [];
    const libraryTracks = libraryResults?.tracks ?? [];
    const libraryAlbums = libraryResults?.albums ?? [];
    const exactLibraryTopArtist = libraryArtists.find((artist) =>
        isExactArtistSearchMatch(artist.name, query, aliasInfo?.canonical),
    );
    const {
        topArtist,
        preferDiscovery: preferDiscoveryTopResult,
        tracks: discoverTracks,
        albums: discoverAlbums,
    } = deriveDiscoverySelection({
        discoverResults,
        query,
        aliasCanonical: aliasInfo?.canonical,
        libraryTopName: exactLibraryTopArtist?.name ?? null,
        showDiscover: true,
    });
    const exactDiscoveryTopArtist =
        topArtist &&
        isExactArtistSearchMatch(topArtist.name, query, aliasInfo?.canonical)
            ? topArtist
            : undefined;
    const displayedTopName =
        exactLibraryTopArtist?.name ?? exactDiscoveryTopArtist?.name;
    const shouldPreferDiscoveryTopResult =
        preferDiscoveryTopResult ||
        Boolean(
            exactLibraryTopArtist &&
            hasCanonicalProviderArtistIdentity(exactDiscoveryTopArtist),
        );
    const hasTopResult = Boolean(
        exactLibraryTopArtist || exactDiscoveryTopArtist,
    );
    const discoverArtistResults = discoverResults.filter(
        (result) => result.type === "music",
    );
    const visibleSimilarArtists = displayedTopName
        ? similarArtists.filter(
              (candidate) =>
                  normalizeArtistName(candidate.name) !==
                  normalizeArtistName(displayedTopName),
          )
        : [];
    const unownedDiscoverTracks = dedupeDiscoverTracks(
        discoverTracks,
        libraryTracks,
    );
    const mergedAlbums = mergeSearchAlbums(discoverAlbums, libraryAlbums);
    const trackLimits = allocateSearchResultLimits({
        primaryCount: libraryTracks.length,
        totalLimit: searchCatalogPolicy.trackDisplayLimit,
    });
    const albumLimits = allocateSearchResultLimits({
        primaryCount: mergedAlbums.libraryAlbums.length,
        totalLimit: searchCatalogPolicy.albumDisplayLimit,
    });

    const hasTracks = hasVisibleTrackResults({
        libraryTrackCount: libraryTracks.length,
        discoverTrackCount: unownedDiscoverTracks.length,
        soulseekResultCount: soulseekResults.length,
        showLibrary: true,
        showDiscover: true,
        showSoulseek: true,
    });
    const hasAlbums =
        mergedAlbums.libraryAlbums.length > 0 ||
        mergedAlbums.discoverAlbums.length > 0;
    const hasArtists =
        libraryArtists.length > 0 || discoverArtistResults.length > 0;
    const primarySongsSurface = resolvePrimarySongsSurface({
        playableTrackCount: libraryTracks.length + unownedDiscoverTracks.length,
        soulseekResultCount: soulseekResults.length,
        soulseekSearching: isSoulseekSearching || isSoulseekPolling,
        showSoulseek: true,
    });
    const isLoading =
        isLibrarySearching ||
        isDiscoverSearching ||
        (showTracksView && (isSoulseekSearching || isSoulseekPolling));
    const trackLoadingState = shouldShowSearchLoadingState({
        hasSearched,
        anySourceSearching: isLoading,
        hasArtistResult: libraryArtists.length > 0,
        discoverResultCount: discoverResults.length,
        primarySongsSurface,
    });
    const activeViewHasResults =
        activeView === "tracks"
            ? hasTracks
            : activeView === "albums"
              ? hasAlbums
              : activeView === "artists"
                ? hasArtists || visibleSimilarArtists.length > 0
                : hasTopResult || hasTracks || hasAlbums || hasArtists;
    const showPrimaryLoadingState = showTracksView
        ? trackLoadingState
        : hasSearched &&
          (isLibrarySearching || isDiscoverSearching) &&
          !activeViewHasResults;

    const handleTVSearch = (searchQuery: string) => {
        router.push(`/search?q=${encodeURIComponent(searchQuery)}`);
    };

    const trackStatus =
        primarySongsSurface === "playable" &&
        (isSoulseekSearching || isSoulseekPolling) ? (
            <span className="inline-flex items-center gap-2 text-sm font-normal text-gray-400">
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                    <circle
                        cx="12"
                        cy="12"
                        r="10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray="40 20"
                    />
                </svg>
                Adding more sources…
            </span>
        ) : undefined;

    const tracksSection =
        hasSearched && showTracksView && primarySongsSurface !== "empty" ? (
            <section>
                {primarySongsSurface === "soulseek" ? null : (
                    <SearchSectionHeader
                        title="Tracks"
                        showAllHref={
                            sectionView === null
                                ? sectionViewLinks.tracks
                                : undefined
                        }
                        status={trackStatus}
                    />
                )}
                {primarySongsSurface === "playable" ? (
                    <>
                        {trackLimits.primaryLimit > 0 ? (
                            <LibraryTracksList
                                tracks={libraryTracks}
                                limit={trackLimits.primaryLimit}
                            />
                        ) : null}
                        {trackLimits.secondaryLimit > 0 &&
                        unownedDiscoverTracks.length > 0 ? (
                            <DiscoverTracksList
                                tracks={unownedDiscoverTracks}
                                limit={trackLimits.secondaryLimit}
                            />
                        ) : null}
                    </>
                ) : primarySongsSurface === "soulseek" ? (
                    <SoulseekSongsList
                        soulseekResults={soulseekResults}
                        downloadingFiles={downloadingFiles}
                        onDownload={handleDownload}
                    />
                ) : (
                    <div className="space-y-2">
                        {[1, 2, 3].map((index) => (
                            <div
                                key={index}
                                className="flex animate-pulse items-center gap-4 rounded-lg bg-white/5 p-3"
                            >
                                <div className="h-10 w-10 rounded bg-white/10" />
                                <div className="flex-1 space-y-2">
                                    <div className="h-4 w-3/4 rounded bg-white/10" />
                                    <div className="h-3 w-1/2 rounded bg-white/10" />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        ) : null;

    const topResult =
        hasSearched && sectionView === null && hasTopResult ? (
            <TopResult
                libraryArtist={exactLibraryTopArtist}
                discoveryArtist={exactDiscoveryTopArtist}
                preferDiscovery={shouldPreferDiscoveryTopResult}
            />
        ) : null;

    return (
        <div
            data-search-results-canvas="true"
            className="relative mx-auto min-h-screen max-w-[1600px] px-4 pb-36 pt-4 sm:px-6 sm:pt-6 lg:px-8"
        >
            <div
                aria-hidden="true"
                data-search-ambient-clip="true"
                className="pointer-events-none absolute inset-0 overflow-hidden"
            >
                <div className="absolute -right-48 -top-64 h-[38rem] w-[38rem] rounded-full bg-brand/[0.07] blur-3xl" />
            </div>
            <TVSearchInput initialQuery={query} onSearch={handleTVSearch} />

            <SearchFilters
                activeView={activeView}
                query={query}
                hasSearched={hasSearched}
            />

            <div className="relative space-y-10 sm:space-y-12">
                {hasSearched && aliasInfo ? (
                    <AliasResolutionBanner aliasInfo={aliasInfo} />
                ) : null}

                {activeView === "all" && (videoInfo || isYtLoading) ? (
                    <YouTubePreviewCard
                        videoInfo={videoInfo!}
                        isLoading={isYtLoading}
                        isDownloading={isDownloading}
                        downloadProgress={downloadProgress}
                        canDownload={canDownloadYouTube}
                        onPlay={handleYtPlay}
                        onDownload={handleYtDownload}
                    />
                ) : null}

                {activeView === "all" &&
                (ytPlaylistInfo || isYtPlaylistLoading || ytPlaylistError) ? (
                    <YouTubePlaylistPreviewCard
                        playlistInfo={ytPlaylistInfo}
                        isLoading={isYtPlaylistLoading}
                        error={ytPlaylistError}
                        isDownloading={isYtPlaylistDownloading}
                        progress={ytPlaylistProgress}
                        canDownload={canDownloadYouTube}
                        onDownloadAll={handleYtDownloadAll}
                        onCancel={handleYtPlaylistCancel}
                    />
                ) : null}

                <EmptyState hasSearched={hasSearched} isLoading={isLoading} />

                {hasSearched && isDiscoverSearching && activeViewHasResults ? (
                    <p
                        role="status"
                        className="-mb-7 inline-flex items-center gap-2 text-sm text-content-secondary"
                    >
                        <span
                            aria-hidden="true"
                            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-brand motion-reduce:animate-none"
                        />
                        Searching online catalog…
                    </p>
                ) : null}

                {showPrimaryLoadingState ? (
                    <div className="relative z-10 flex flex-col items-center justify-center py-16">
                        <div className="relative mb-4 h-16 w-16">
                            <svg
                                className="h-16 w-16 animate-spin"
                                viewBox="0 0 64 64"
                            >
                                <circle
                                    cx="32"
                                    cy="32"
                                    r="28"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="4"
                                    strokeLinecap="round"
                                    strokeDasharray="140 40"
                                    className="text-brand"
                                />
                            </svg>
                        </div>
                        <p className="text-sm text-gray-400">
                            {isSoulseekSearching || isSoulseekPolling
                                ? `Searching… (${soulseekResults.length} found)`
                                : "Searching…"}
                        </p>
                    </div>
                ) : null}

                {topResult && tracksSection ? (
                    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(20rem,2fr)_minmax(0,3fr)]">
                        {topResult}
                        {tracksSection}
                    </div>
                ) : (
                    <>
                        {topResult}
                        {tracksSection}
                    </>
                )}

                {hasSearched &&
                (sectionView === null || isAlbumsView) &&
                hasAlbums ? (
                    <section>
                        <SearchSectionHeader
                            title="Albums"
                            showAllHref={
                                sectionView === null
                                    ? sectionViewLinks.albums
                                    : undefined
                            }
                        />
                        <div
                            className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10"
                            data-tv-section="search-results-albums"
                        >
                            {albumLimits.primaryLimit > 0 ? (
                                <LibraryAlbumsGrid
                                    albums={mergedAlbums.libraryAlbums}
                                    limit={albumLimits.primaryLimit}
                                    embedded
                                />
                            ) : null}
                            {albumLimits.secondaryLimit > 0 &&
                            mergedAlbums.discoverAlbums.length > 0 ? (
                                <ProviderAlbumsGrid
                                    albums={mergedAlbums.discoverAlbums}
                                    limit={albumLimits.secondaryLimit}
                                    embedded
                                    indexOffset={albumLimits.primaryLimit}
                                />
                            ) : null}
                        </div>
                    </section>
                ) : null}

                {hasSearched &&
                (sectionView === null || isArtistsView) &&
                hasArtists ? (
                    <section>
                        <SearchSectionHeader
                            title="Artists"
                            showAllHref={
                                sectionView === null
                                    ? sectionViewLinks.artists
                                    : undefined
                            }
                        />
                        <SearchArtistsGrid
                            libraryArtists={libraryArtists}
                            discoveryArtists={discoverArtistResults}
                            excludeNames={
                                sectionView === null && displayedTopName
                                    ? [displayedTopName]
                                    : []
                            }
                            limit={isArtistsView ? 50 : 6}
                        />
                    </section>
                ) : null}

                {hasSearched &&
                isArtistsView &&
                hasTopResult &&
                visibleSimilarArtists.length > 0 ? (
                    <SimilarArtistsGrid
                        similarArtists={visibleSimilarArtists}
                        title="Related Artists"
                    />
                ) : null}

                {hasSearched &&
                !isLoading &&
                !activeViewHasResults &&
                !videoInfo &&
                !ytPlaylistInfo ? (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <SearchIcon className="mb-4 h-16 w-16 text-gray-400" />
                        <h3 className="mb-2 text-xl font-bold text-white">
                            No results found
                        </h3>
                        <p className="text-gray-400">
                            Try searching for something else
                        </p>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
