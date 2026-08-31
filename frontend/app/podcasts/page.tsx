"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { Mic2, Search, Plus, Link2 } from "lucide-react";
import { useToast } from "@/lib/toast-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { usePodcastsQuery, useTopPodcastsQuery } from "@/hooks/useQueries";
import Image from "next/image";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { useFeatures } from "@/lib/features-context";
import { PeerBadge } from "@/components/ui/PeerBadge";
import type { PeerPodcastListing } from "@/lib/api/podcasts";
import { queryKeys } from "@/lib/queryKeys";
import {
    formatPageRu,
    formatPerPageRu,
    formatPodcastCountRu,
    formatPodcastSearchEmptyRu,
    formatPodcastSubscribedRu,
    podcastRu,
} from "@/lib/i18n/podcastRu";
import { userFacingError } from "@/lib/i18n/ru";

// Always proxy images through the backend for caching and mobile compatibility
const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

interface SearchResult {
    type?: string;
    id: number;
    name?: string;
    artist?: string;
    title?: string;
    author?: string;
    coverUrl: string;
    feedUrl: string;
    trackCount?: number;
    itunesId?: number;
}

/**
 * Renders the PodcastsPage component.
 */
export default function PodcastsPage() {
    const [searchQuery, setSearchQuery] = useState("");
    const [rssUrl, setRssUrl] = useState("");
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isAddingRss, setIsAddingRss] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const { isAuthenticated } = useAuth();
    const router = useRouter();
    const { toast } = useToast();

    // Use React Query hooks
    const { data: podcasts = [], isLoading: isLoadingPodcasts } =
        usePodcastsQuery();
    const { data: topPodcasts = [], isLoading: isLoadingTopPodcasts } =
        useTopPodcastsQuery(12);

    // Fetch genre-based discovery podcasts
    const { data: relatedPodcasts = {}, isLoading: isLoadingRelatedPodcasts } =
        useQuery({
            queryKey: queryKeys.podcastDiscoveryGenres(),
            queryFn: async () => {
                const genreIds = [1303, 1324, 1489, 1488, 1321, 1545, 1502];
                return api.getPodcastsByGenre(genreIds);
            },
            staleTime: 10 * 60 * 1000,
            enabled: isAuthenticated,
        });

    // Sorting and pagination state for "My Podcasts"
    type SortOption = "title" | "author" | "recent";
    const [sortBy, setSortBy] = useState<SortOption>("title");
    const [itemsPerPage, setItemsPerPage] = useState<number>(50);
    const [currentPage, setCurrentPage] = useState(1);

    const showMyPodcastsSkeleton = isLoadingPodcasts && podcasts.length === 0;
    const showTopPodcastsSkeleton =
        isLoadingTopPodcasts && topPodcasts.length === 0;
    const showGenreDiscoverySkeleton =
        isAuthenticated &&
        isLoadingRelatedPodcasts &&
        Object.keys(relatedPodcasts).length === 0;

    // Sort and paginate "My Podcasts"
    const sortedPodcasts = useMemo(() => {
        const sorted = [...podcasts];
        switch (sortBy) {
            case "title":
                sorted.sort((a, b) => a.title.localeCompare(b.title));
                break;
            case "author":
                sorted.sort((a, b) => a.author.localeCompare(b.author));
                break;
            case "recent":
                // Sort by episode count (most episodes = most likely actively listened)
                sorted.sort(
                    (a, b) => (b.episodeCount || 0) - (a.episodeCount || 0),
                );
                break;
        }
        return sorted;
    }, [podcasts, sortBy]);

    const totalPages = Math.ceil(sortedPodcasts.length / itemsPerPage);
    const paginatedPodcasts = useMemo(() => {
        const start = (currentPage - 1) * itemsPerPage;
        return sortedPodcasts.slice(start, start + itemsPerPage);
    }, [sortedPodcasts, currentPage, itemsPerPage]);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(event.target as Node)
            ) {
                setShowDropdown(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Debounced search
    useEffect(() => {
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        if (searchQuery.trim().length < 2) {
            return;
        }

        searchTimeoutRef.current = setTimeout(async () => {
            try {
                // Use discover endpoint to search iTunes for NEW podcasts
                const results = await api.discoverSearch(
                    searchQuery,
                    "podcasts",
                    8,
                );

                // Filter for podcasts from the results array
                const podcastResults =
                    results?.results?.filter(
                        (r: { type: string }) => r.type === "podcast",
                    ) || [];
                setSearchResults(podcastResults);
                setShowDropdown(podcastResults.length > 0);
            } catch (error) {
                sharedFrontendLogger.error("Podcast search failed:", error);
                setSearchResults([]);
                setShowDropdown(false);
            } finally {
                setIsSearching(false);
            }
        }, 500);

        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchQuery]);

    const handleAddByRss = async () => {
        if (isAddingRss) return;

        const trimmedUrl = rssUrl.trim();
        if (!trimmedUrl) {
            toast.error(podcastRu.errors.rssRequired);
            return;
        }

        try {
            const parsedUrl = new URL(trimmedUrl);
            if (
                parsedUrl.protocol !== "http:" &&
                parsedUrl.protocol !== "https:"
            ) {
                toast.error(podcastRu.errors.rssProtocol);
                return;
            }
        } catch {
            toast.error(podcastRu.errors.rssInvalid);
            return;
        }

        try {
            setIsAddingRss(true);
            const response = await api.subscribePodcast(trimmedUrl);

            if (response.success && response.podcast?.id) {
                setRssUrl("");
                toast.success(podcastRu.success.subscribed);
                router.push(`/podcasts/${response.podcast.id}`);
                return;
            }

            toast.error(podcastRu.errors.rssSubscribeFailed);
        } catch (error: unknown) {
            toast.error(
                userFacingError(error, podcastRu.errors.rssSubscribeFailed),
            );
        } finally {
            setIsAddingRss(false);
        }
    };

    return (
        <div data-routed-surface="podcasts" className="min-h-screen bg-surface">
            <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                <div>
                    <PageHeader
                        title={podcastRu.main.title}
                        subtitle={podcastRu.main.subtitle}
                        icon={Mic2}
                        className="mb-4"
                    />

                    <section className="grid gap-4 border-y border-line py-5 lg:grid-cols-2">
                        {/* Quick Search - Full Width on Mobile */}
                        <div className="relative w-full" ref={dropdownRef}>
                            <Search className="absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-content-muted" />
                            <input
                                type="text"
                                aria-label="Найти подкаст"
                                value={searchQuery}
                                onChange={(e) => {
                                    const nextQuery = e.target.value;
                                    const canSearch =
                                        nextQuery.trim().length >= 2;

                                    setSearchQuery(nextQuery);
                                    setIsSearching(canSearch);

                                    if (!canSearch) {
                                        setSearchResults([]);
                                        setShowDropdown(false);
                                    }
                                }}
                                placeholder={podcastRu.main.quickAdd}
                                className="min-h-12 w-full rounded-xl border border-line bg-surface-elevated py-3 pl-11 pr-12 text-base text-content outline-none transition-colors placeholder:text-content-muted hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                            />
                            {isSearching && (
                                <div className="absolute right-4 top-1/2 z-10 -translate-y-1/2">
                                    <GradientSpinner size="sm" />
                                </div>
                            )}

                            {/* Dropdown Results */}
                            {showDropdown && searchResults.length > 0 && (
                                <div className="absolute left-0 top-full z-50 mt-2 max-h-96 w-full overflow-y-auto rounded-xl border border-line bg-surface-overlay shadow-2xl">
                                    {searchResults.map((result) => {
                                        const imageUrl = getProxiedImageUrl(
                                            result.coverUrl,
                                        );
                                        return (
                                            <button
                                                type="button"
                                                key={result.id}
                                                className="flex min-h-11 w-full items-center gap-3 border-b border-line p-3 text-left transition-colors last:border-b-0 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-light motion-reduce:transition-none"
                                                onClick={() => {
                                                    router.push(
                                                        `/podcasts/${result.id}`,
                                                    );
                                                    setShowDropdown(false);
                                                }}
                                            >
                                                <div className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-full bg-surface-highlight">
                                                    {imageUrl ? (
                                                        <Image
                                                            src={imageUrl}
                                                            alt={
                                                                result.name ||
                                                                podcastRu.main
                                                                    .fallbackAlt
                                                            }
                                                            fill
                                                            sizes="48px"
                                                            className="object-cover"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <div className="flex h-full w-full items-center justify-center">
                                                            <Mic2 className="h-6 w-6 text-content-muted" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <h3 className="truncate text-sm font-semibold text-content">
                                                        {result.name}
                                                    </h3>
                                                    <p className="truncate text-xs text-content-muted">
                                                        {result.artist}
                                                    </p>
                                                </div>
                                                <Plus className="h-5 w-5 flex-shrink-0 text-brand-light" />
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

                            {/* No Results */}
                            {showDropdown &&
                                searchResults.length === 0 &&
                                !isSearching &&
                                searchQuery.length >= 2 && (
                                    <div className="absolute left-0 top-full z-50 mt-2 w-full rounded-xl border border-line bg-surface-overlay p-4 shadow-2xl">
                                        <p className="text-center text-sm text-content-muted">
                                            {formatPodcastSearchEmptyRu(
                                                searchQuery,
                                            )}
                                        </p>
                                    </div>
                                )}
                        </div>

                        {/* Add by RSS URL */}
                        <div className="w-full">
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <div className="relative flex-1">
                                    <Link2 className="absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-content-muted" />
                                    <input
                                        type="url"
                                        aria-label="RSS-адрес подкаста"
                                        value={rssUrl}
                                        onChange={(e) =>
                                            setRssUrl(e.target.value)
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                handleAddByRss();
                                            }
                                        }}
                                        placeholder={
                                            podcastRu.main.rssPlaceholder
                                        }
                                        className="min-h-12 w-full rounded-xl border border-line bg-surface-elevated py-3 pl-11 pr-4 text-base text-content outline-none transition-colors placeholder:text-content-muted hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                                    />
                                </div>
                                <button
                                    onClick={handleAddByRss}
                                    disabled={isAddingRss}
                                    className="min-h-12 rounded-xl bg-brand px-5 py-3 text-sm font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
                                >
                                    {isAddingRss
                                        ? podcastRu.main.rssAdding
                                        : podcastRu.main.addRss}
                                </button>
                            </div>
                            <p className="mt-2 px-1 text-xs text-content-muted">
                                {podcastRu.main.example}{" "}
                                <span className="font-mono">
                                    https://example.com/podcast/feed.xml
                                </span>
                            </p>
                        </div>
                    </section>
                </div>

                <div className="space-y-12 pt-10">
                    {/* My Podcasts */}
                    {(podcasts.length > 0 || showMyPodcastsSkeleton) && (
                        <section>
                            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                                <h2 className="text-2xl font-black tracking-[-0.03em] text-content">
                                    {podcastRu.main.myPodcasts}
                                </h2>
                                <div className="flex flex-wrap items-center gap-2">
                                    {/* Sort Dropdown */}
                                    <select
                                        value={sortBy}
                                        onChange={(e) => {
                                            setSortBy(
                                                e.target.value as SortOption,
                                            );
                                            setCurrentPage(1);
                                        }}
                                        aria-label="Сортировка подкастов"
                                        className="min-h-11 rounded-xl border border-line bg-surface-elevated px-4 py-2 text-sm text-content outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/20 [&>option]:bg-surface-elevated [&>option]:text-content"
                                        disabled={showMyPodcastsSkeleton}
                                    >
                                        <option value="title">
                                            {podcastRu.main.sortTitle}
                                        </option>
                                        <option value="author">
                                            {podcastRu.main.sortAuthor}
                                        </option>
                                        <option value="recent">
                                            {podcastRu.main.sortEpisodes}
                                        </option>
                                    </select>

                                    {/* Items per page */}
                                    <select
                                        value={itemsPerPage}
                                        onChange={(e) => {
                                            setItemsPerPage(
                                                Number(e.target.value),
                                            );
                                            setCurrentPage(1);
                                        }}
                                        aria-label="Подкастов на странице"
                                        className="min-h-11 rounded-xl border border-line bg-surface-elevated px-4 py-2 text-sm text-content outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/20 [&>option]:bg-surface-elevated [&>option]:text-content"
                                        disabled={showMyPodcastsSkeleton}
                                    >
                                        {[25, 50, 100, 250].map((count) => (
                                            <option key={count} value={count}>
                                                {formatPerPageRu(count)}
                                            </option>
                                        ))}
                                    </select>

                                    <span className="text-sm text-content-muted">
                                        {formatPodcastCountRu(podcasts.length)}
                                    </span>
                                </div>
                            </div>
                            {showMyPodcastsSkeleton ? (
                                <PodcastGridSkeleton count={10} />
                            ) : (
                                <div
                                    className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 3xl:grid-cols-5 gap-4"
                                    data-tv-section="my-podcasts"
                                >
                                    {paginatedPodcasts.map((podcast, index) => {
                                        const imageUrl = getProxiedImageUrl(
                                            podcast.coverUrl,
                                        );
                                        return (
                                            <button
                                                type="button"
                                                key={podcast.id}
                                                onClick={() =>
                                                    router.push(
                                                        `/podcasts/${podcast.id}`,
                                                    )
                                                }
                                                data-tv-card
                                                data-tv-card-index={index}
                                                data-podcast-card="open"
                                                className="group w-full rounded-xl p-1.5 text-left transition duration-200 hover:-translate-y-0.5 hover:bg-surface-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none sm:p-2"
                                            >
                                                <div className="w-full aspect-square bg-surface-highlight rounded-full mb-2.5 overflow-hidden relative shadow-lg">
                                                    {imageUrl ? (
                                                        <Image
                                                            src={imageUrl}
                                                            alt={podcast.title}
                                                            fill
                                                            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                                            className="object-cover group-hover:scale-105 transition-transform"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Mic2 className="h-16 w-16 text-content-muted" />
                                                        </div>
                                                    )}
                                                </div>
                                                <h3 className="mb-0.5 truncate text-sm font-semibold text-content">
                                                    {podcast.title}
                                                </h3>
                                                <p className="truncate text-xs text-content-muted">
                                                    {podcast.author}
                                                </p>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Pagination Controls */}
                            {!showMyPodcastsSkeleton && totalPages > 1 && (
                                <div className="mt-8 flex flex-wrap items-center justify-center gap-2 border-t border-line pt-4">
                                    <button
                                        onClick={() => setCurrentPage(1)}
                                        disabled={currentPage === 1}
                                        className="min-h-11 rounded-xl px-3 py-2 text-sm text-content-muted transition-colors hover:bg-surface-elevated hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {podcastRu.main.firstPage}
                                    </button>
                                    <button
                                        onClick={() =>
                                            setCurrentPage((p) =>
                                                Math.max(1, p - 1),
                                            )
                                        }
                                        disabled={currentPage === 1}
                                        className="min-h-11 rounded-xl px-3 py-2 text-sm text-content-muted transition-colors hover:bg-surface-elevated hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {podcastRu.main.previousPage}
                                    </button>
                                    <span className="px-2 py-2 text-sm text-content sm:px-4">
                                        {formatPageRu(currentPage, totalPages)}
                                    </span>
                                    <button
                                        onClick={() =>
                                            setCurrentPage((p) =>
                                                Math.min(totalPages, p + 1),
                                            )
                                        }
                                        disabled={currentPage === totalPages}
                                        className="min-h-11 rounded-xl px-3 py-2 text-sm text-content-muted transition-colors hover:bg-surface-elevated hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {podcastRu.main.nextPage}
                                    </button>
                                    <button
                                        onClick={() =>
                                            setCurrentPage(totalPages)
                                        }
                                        disabled={currentPage === totalPages}
                                        className="min-h-11 rounded-xl px-3 py-2 text-sm text-content-muted transition-colors hover:bg-surface-elevated hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {podcastRu.main.lastPage}
                                    </button>
                                </div>
                            )}
                        </section>
                    )}

                    {/* Top Podcasts */}
                    {(topPodcasts.length > 0 || showTopPodcastsSkeleton) && (
                        <section>
                            <h2 className="mb-6 text-2xl font-black tracking-[-0.03em] text-content">
                                {podcastRu.main.topPodcasts}
                            </h2>
                            {showTopPodcastsSkeleton ? (
                                <PodcastGridSkeleton count={10} />
                            ) : (
                                <div
                                    className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 3xl:grid-cols-5 gap-4"
                                    data-tv-section="top-podcasts"
                                >
                                    {topPodcasts.map((podcast, index) => {
                                        const imageUrl = getProxiedImageUrl(
                                            podcast.coverUrl,
                                        );
                                        return (
                                            <button
                                                type="button"
                                                key={podcast.id}
                                                onClick={() =>
                                                    router.push(
                                                        `/podcasts/${podcast.id}`,
                                                    )
                                                }
                                                data-tv-card
                                                data-tv-card-index={index}
                                                data-podcast-card="open"
                                                className="group w-full rounded-xl p-1.5 text-left transition duration-200 hover:-translate-y-0.5 hover:bg-surface-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none sm:p-2"
                                            >
                                                <div className="w-full aspect-square bg-surface-highlight rounded-full mb-2.5 overflow-hidden relative shadow-lg">
                                                    {imageUrl ? (
                                                        <Image
                                                            src={imageUrl}
                                                            alt={podcast.title}
                                                            fill
                                                            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                                            className="object-cover group-hover:scale-105 transition-transform"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Mic2 className="h-16 w-16 text-content-muted" />
                                                        </div>
                                                    )}
                                                </div>
                                                <h3 className="mb-0.5 truncate text-sm font-semibold text-content">
                                                    {podcast.title}
                                                </h3>
                                                <p className="truncate text-xs text-content-muted">
                                                    {podcast.author}
                                                </p>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </section>
                    )}

                    <PeerPodcastsSection />

                    {showGenreDiscoverySkeleton && (
                        <section>
                            <h2 className="mb-6 text-2xl font-black tracking-[-0.03em] text-content">
                                {podcastRu.main.loadingDiscovery}
                            </h2>
                            <PodcastGridSkeleton count={5} />
                        </section>
                    )}

                    {/* Genre-based Discovery - Ordered by popularity */}
                    {[
                        { id: "1303", name: podcastRu.main.genres.comedy },
                        { id: "1324", name: podcastRu.main.genres.society },
                        { id: "1489", name: podcastRu.main.genres.news },
                        { id: "1488", name: podcastRu.main.genres.trueCrime },
                        { id: "1321", name: podcastRu.main.genres.business },
                        { id: "1545", name: podcastRu.main.genres.sports },
                        { id: "1502", name: podcastRu.main.genres.leisure },
                    ].map(({ id: genreId, name: genreName }) => {
                        const genrePodcasts = relatedPodcasts[genreId] || [];

                        return genrePodcasts.length > 0 ? (
                            <section key={genreId}>
                                <div className="flex items-center justify-between mb-6">
                                    <h2 className="text-2xl font-black tracking-[-0.03em] text-content">
                                        {genreName}
                                    </h2>
                                    <button
                                        onClick={() =>
                                            router.push(
                                                `/podcasts/genre/${genreId}`,
                                            )
                                        }
                                        className="min-h-11 rounded-xl px-3 text-sm font-semibold text-content-muted transition-colors hover:bg-surface-elevated hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                                    >
                                        {podcastRu.main.viewMore}
                                    </button>
                                </div>
                                <div
                                    className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 3xl:grid-cols-5 gap-4"
                                    data-tv-section={`genre-${genreId}`}
                                >
                                    {genrePodcasts.map((podcast, index) => {
                                        const imageUrl = getProxiedImageUrl(
                                            podcast.coverUrl,
                                        );
                                        return (
                                            <button
                                                type="button"
                                                key={podcast.id}
                                                onClick={() =>
                                                    router.push(
                                                        `/podcasts/${podcast.id}`,
                                                    )
                                                }
                                                data-tv-card
                                                data-tv-card-index={index}
                                                data-podcast-card="open"
                                                className="group w-full rounded-xl p-1.5 text-left transition duration-200 hover:-translate-y-0.5 hover:bg-surface-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none sm:p-2"
                                            >
                                                <div className="w-full aspect-square bg-surface-highlight rounded-full mb-2.5 overflow-hidden relative shadow-lg">
                                                    {imageUrl ? (
                                                        <Image
                                                            src={imageUrl}
                                                            alt={podcast.title}
                                                            fill
                                                            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                                            className="object-cover group-hover:scale-105 transition-transform"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Mic2 className="h-16 w-16 text-content-muted" />
                                                        </div>
                                                    )}
                                                </div>
                                                <h3 className="truncate text-sm font-bold text-content">
                                                    {podcast.title}
                                                </h3>
                                                <p className="truncate text-xs text-content-muted">
                                                    {podcast.author}
                                                </p>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        ) : null;
                    })}

                    {/* Empty State */}
                    {!isLoadingPodcasts &&
                        !isLoadingTopPodcasts &&
                        !showGenreDiscoverySkeleton &&
                        podcasts.length === 0 &&
                        topPodcasts.length === 0 && (
                            <section className="border-y border-line">
                                <EmptyState
                                    icon={<Mic2 />}
                                    title={podcastRu.main.emptyTitle}
                                    description={
                                        podcastRu.main.emptyDescription
                                    }
                                />
                            </section>
                        )}
                </div>
            </div>
        </div>
    );
}

function PeerPodcastsSection() {
    const { federation } = useFeatures();
    const { isAuthenticated } = useAuth();
    const { toast } = useToast();
    const [subscribingId, setSubscribingId] = useState<string | null>(null);
    const enabled = federation && isAuthenticated;
    const { data: listings = [], refetch } = useQuery({
        queryKey: queryKeys.podcastPeers(),
        queryFn: () => api.getPeerPodcasts(),
        staleTime: 5 * 60 * 1000,
        enabled,
    });

    if (!enabled || listings.length === 0) return null;

    const subscribe = async (listing: PeerPodcastListing) => {
        setSubscribingId(listing.id);
        try {
            const response = await api.subscribePodcast(listing.feedUrl);
            if (response.success) {
                toast.success(formatPodcastSubscribedRu(listing.title));
                await refetch();
                return;
            }
            toast.error(podcastRu.errors.subscribeFailed);
        } catch (error: unknown) {
            toast.error(
                userFacingError(error, podcastRu.errors.subscribeFailed),
            );
        } finally {
            setSubscribingId(null);
        }
    };

    return (
        <section>
            <h2 className="mb-6 text-2xl font-black tracking-[-0.03em] text-content">
                {podcastRu.main.peerPodcasts}
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {listings.map((listing) => (
                    <div
                        key={listing.id}
                        className="border-t border-line p-2 pt-3"
                    >
                        <div className="relative mb-3 aspect-square overflow-hidden rounded-md bg-surface-highlight">
                            {getProxiedImageUrl(
                                listing.imageUrl ?? undefined,
                            ) && (
                                <Image
                                    src={
                                        getProxiedImageUrl(
                                            listing.imageUrl ?? undefined,
                                        ) as string
                                    }
                                    alt=""
                                    fill
                                    sizes="200px"
                                    className="object-cover"
                                />
                            )}
                        </div>
                        <h3 className="mb-0.5 truncate text-sm font-semibold text-content">
                            {listing.title}
                        </h3>
                        <p className="truncate text-xs text-content-muted">
                            {listing.author ?? ""}
                        </p>
                        <div className="mt-2 flex items-center justify-between gap-2">
                            <PeerBadge
                                peerName={listing.peer.name}
                                online={listing.peer.online}
                            />
                            {listing.subscribed ? (
                                <span className="text-[10px] uppercase text-content-muted">
                                    {podcastRu.main.subscribed}
                                </span>
                            ) : (
                                <button
                                    type="button"
                                    disabled={subscribingId === listing.id}
                                    onClick={() => void subscribe(listing)}
                                    className="min-h-11 rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-50"
                                >
                                    {podcastRu.main.subscribe}
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}

function PodcastGridSkeleton({ count = 10 }: { count?: number }) {
    return (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {Array.from({ length: count }, (_, index) => (
                <div
                    key={`podcast-skeleton-${index}`}
                    className="animate-pulse rounded-xl p-2 motion-reduce:animate-none"
                >
                    <div className="mb-2.5 aspect-square w-full rounded-full bg-surface-elevated" />
                    <div className="mb-2 h-4 rounded bg-surface-elevated" />
                    <div className="h-3 w-2/3 rounded bg-surface-elevated" />
                </div>
            ))}
        </div>
    );
}
