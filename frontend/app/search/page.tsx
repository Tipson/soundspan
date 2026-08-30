"use client";

import { useState } from "react";
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
import { ru } from "@/lib/i18n/ru";

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
    const [trackPagination, setTrackPagination] = useState({
        query,
        limit: 50,
    });
    const discoverTrackLimit =
        trackPagination.query === query ? trackPagination.limit : 50;
    const showTracksView = sectionView === null || isTracksView;
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
        canRequestMoreDiscoverTracks,
        hasNextLibraryTracks,
        isFetchingNextLibraryTracks,
        fetchNextLibraryTracks,
    } = useSearchData({
        query,
        libraryType: searchCatalogPolicy.libraryType,
        discoverType: searchCatalogPolicy.discoverType,
        libraryLimit: searchCatalogPolicy.libraryLimit,
        discoverLimit: isTracksView
            ? discoverTrackLimit
            : searchCatalogPolicy.discoverLimit,
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
    const trackLimits = isTracksView
        ? {
              primaryLimit: libraryTracks.length,
              secondaryLimit: unownedDiscoverTracks.length,
          }
        : allocateSearchResultLimits({
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

    const activeViewLabel =
        activeView === "tracks"
            ? ru.search.tracks
            : activeView === "albums"
              ? ru.search.albums
              : activeView === "artists"
                ? ru.search.artists
                : ru.search.bestMatches;

    const trackStatus =
        primarySongsSurface === "playable" &&
        (isSoulseekSearching || isSoulseekPolling) ? (
            <span className="inline-flex items-center gap-2 text-sm font-normal text-gray-400">
                <span
                    aria-hidden="true"
                    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-brand motion-reduce:animate-none"
                />
                {ru.search.addingSources}
            </span>
        ) : undefined;

    const tracksSection =
        hasSearched && showTracksView && primarySongsSurface !== "empty" ? (
            <section className="min-w-0 rounded-[1.5rem] border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5">
                {primarySongsSurface === "soulseek" ? null : (
                    <SearchSectionHeader
                        title={ru.search.tracks}
                        description={
                            sectionView === null
                                ? ru.search.popularMatches
                                : ru.search.progressiveMatches
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
                        {isTracksView &&
                        (hasNextLibraryTracks ||
                            canRequestMoreDiscoverTracks) ? (
                            <div className="mt-4 flex justify-center">
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (hasNextLibraryTracks) {
                                            void fetchNextLibraryTracks();
                                        }
                                        if (canRequestMoreDiscoverTracks) {
                                            setTrackPagination((current) => ({
                                                query,
                                                limit:
                                                    current.query === query
                                                        ? current.limit + 50
                                                        : 100,
                                            }));
                                        }
                                    }}
                                    disabled={
                                        isFetchingNextLibraryTracks ||
                                        isDiscoverSearching
                                    }
                                    className="min-h-11 rounded-full border border-white/15 bg-white/[0.04] px-5 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
                                >
                                    {isFetchingNextLibraryTracks ||
                                    isDiscoverSearching
                                        ? ru.search.loadingMore
                                        : `${ru.search.loadMore} (${libraryTracks.length + unownedDiscoverTracks.length} ${ru.search.loaded})`}
                                </button>
                            </div>
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
            className="relative mx-auto min-h-full max-w-[1520px] overflow-x-clip px-3 pb-40 pt-3 sm:px-6 sm:pb-32 sm:pt-5 lg:px-8"
        >
            <div
                aria-hidden="true"
                data-search-ambient-clip="true"
                className="pointer-events-none absolute inset-0 overflow-hidden"
            >
                <div className="absolute -right-48 -top-64 h-[38rem] w-[38rem] rounded-full bg-brand/[0.075] blur-3xl" />
                <div className="absolute -left-56 top-72 h-[30rem] w-[30rem] rounded-full bg-violet-500/[0.045] blur-3xl" />
            </div>
            <TVSearchInput
                key={query}
                initialQuery={query}
                onSearch={handleTVSearch}
            />

            {hasSearched ? (
                <header
                    data-search-query-heading="true"
                    className="relative mb-5 pt-2 sm:mb-6 sm:pt-4"
                >
                    <p className="mb-1 text-[0.6875rem] font-bold uppercase tracking-[0.18em] text-content-muted">
                        {ru.search.title}
                    </p>
                    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                        <h1 className="min-w-0 text-balance text-3xl font-black tracking-[-0.045em] text-content sm:text-5xl">
                            {ru.search.resultsFor}{" "}
                            <span className="text-content-secondary">
                                “{query.trim()}”
                            </span>
                        </h1>
                        <p className="pb-1 text-sm font-semibold text-content-secondary">
                            {activeViewLabel}
                        </p>
                    </div>
                </header>
            ) : null}

            <SearchFilters
                activeView={activeView}
                query={query}
                hasSearched={hasSearched}
            />

            <div className="relative space-y-8 sm:space-y-10">
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
                        {ru.search.onlineCatalog}
                    </p>
                ) : null}

                {showPrimaryLoadingState ? (
                    <div className="relative z-10 flex min-h-[18rem] flex-col items-center justify-center rounded-[1.5rem] border border-white/[0.08] bg-white/[0.025] py-16">
                        <span
                            aria-hidden="true"
                            className="mb-4 h-12 w-12 animate-spin rounded-full border-[3px] border-white/10 border-t-brand motion-reduce:animate-none"
                        />
                        <p className="text-sm text-content-secondary">
                            {isSoulseekSearching || isSoulseekPolling
                                ? `${ru.search.loading} (${soulseekResults.length} ${ru.search.found})`
                                : ru.search.loading}
                        </p>
                    </div>
                ) : null}

                {topResult && tracksSection ? (
                    <div
                        data-search-primary-grid="true"
                        className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(17rem,0.85fr)_minmax(0,1.35fr)]"
                    >
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
                            title={ru.search.albums}
                            description={ru.search.albumDescription}
                        />
                        <div
                            className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6"
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
                            title={ru.search.artists}
                            description={ru.search.artistDescription}
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
                        title={ru.search.relatedArtists}
                    />
                ) : null}

                {hasSearched &&
                !isLoading &&
                !activeViewHasResults &&
                !videoInfo &&
                !ytPlaylistInfo ? (
                    <section
                        aria-labelledby="search-no-results-title"
                        className="flex min-h-[22rem] flex-col items-center justify-center rounded-[1.5rem] border border-white/[0.08] bg-white/[0.025] px-6 py-16 text-center"
                    >
                        <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.05] text-content-muted">
                            <SearchIcon
                                className="h-6 w-6"
                                aria-hidden="true"
                            />
                        </span>
                        <h2
                            id="search-no-results-title"
                            className="mb-2 text-2xl font-black tracking-[-0.035em] text-content"
                        >
                            {ru.search.noMatch} “{query.trim()}”
                        </h2>
                        <p className="max-w-md text-sm leading-6 text-content-secondary">
                            {ru.search.noMatchHint}
                        </p>
                    </section>
                ) : null}
            </div>
        </div>
    );
}
