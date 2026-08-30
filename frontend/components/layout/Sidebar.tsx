"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import {
    ArrowUpDown,
    AudioWaveform,
    Heart,
    Home,
    Library,
    Plus,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { MobileSidebar } from "./MobileSidebar";
import { SIDEBAR_NAVIGATION } from "./socialNavigation";
import { useLikedPlaylistQuery } from "@/hooks/useQueries";
import { usePeerPlaylists } from "@/features/social/hooks/usePeerPlaylists";
import { useFeatures } from "@/lib/features-context";
import { PeerBadge } from "@/components/ui/PeerBadge";
import {
    buildUnifiedPlaylistRows,
    playlistFilterOptions,
    type UnifiedPlaylistFilter,
    type UnifiedPlaylistSort,
} from "@/lib/unifiedPlaylists";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { handleOfflineLibraryNavigation } from "./offlineLibraryNavigation";

interface Playlist {
    id: string;
    name: string;
    trackCount: number;
    createdAt?: string;
    updatedAt?: string;
    isHidden?: boolean;
    isOwner?: boolean;
    user?: { username: string };
}

const sidebarNavigationIcons = {
    "/": Home,
    "/vibe": AudioWaveform,
    "/library": Library,
} as const;

type PlaylistSort = UnifiedPlaylistSort;
type PlaylistFilter = UnifiedPlaylistFilter;

/**
 * Renders the Sidebar component.
 */
export function Sidebar() {
    const pathname = usePathname();
    const { isAuthenticated } = useAuth();
    // Listen Together is intentionally outside primary navigation, so the
    // sidebar must not start its optional polling loop.
    const hasActiveSessions = false;
    const likedQuery = useLikedPlaylistQuery(1);
    const likedTotal = likedQuery.data?.total ?? 0;
    const { federation } = useFeatures();
    const { playlists: peerPlaylists } = usePeerPlaylists();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [playlists, setPlaylists] = useState<Playlist[]>([]);
    const [isLoadingPlaylists, setIsLoadingPlaylists] = useState(false);
    const [playlistSort, setPlaylistSort] = useState<PlaylistSort>("updated");
    const [playlistFilter, setPlaylistFilter] = useState<PlaylistFilter>("all");
    const [isSortFilterOpen, setIsSortFilterOpen] = useState(false);
    const [sortFilterPos, setSortFilterPos] = useState<{
        top: number;
        left: number;
    } | null>(null);
    const sortFilterRef = useRef<HTMLDivElement>(null);
    const sortFilterBtnRef = useRef<HTMLButtonElement>(null);
    const hasLoadedPlaylists = useRef(false);

    // Load playlists only once
    useEffect(() => {
        let loadingTimeout: NodeJS.Timeout | null = null;

        const loadPlaylists = async () => {
            if (
                !isAuthenticated ||
                isMobileOrTablet ||
                hasLoadedPlaylists.current
            ) {
                return;
            }

            // Delay showing loading state to avoid flicker
            loadingTimeout = setTimeout(() => setIsLoadingPlaylists(true), 200);
            hasLoadedPlaylists.current = true;
            try {
                const data = await api.getPlaylists();
                setPlaylists(data);
            } catch (error) {
                sharedFrontendLogger.error("Failed to load playlists:", error);
                hasLoadedPlaylists.current = false; // Allow retry on error
            } finally {
                if (loadingTimeout) clearTimeout(loadingTimeout);
                setIsLoadingPlaylists(false);
            }
        };

        loadPlaylists();

        // Listen for playlist events to refresh playlists
        const handlePlaylistEvent = async () => {
            if (!isAuthenticated || isMobileOrTablet) return;
            try {
                const data = await api.getPlaylists();
                setPlaylists(data);
            } catch (error) {
                sharedFrontendLogger.error(
                    "Failed to reload playlists:",
                    error,
                );
            }
        };

        window.addEventListener("playlist-created", handlePlaylistEvent);
        window.addEventListener("playlist-updated", handlePlaylistEvent);
        window.addEventListener("playlist-deleted", handlePlaylistEvent);

        return () => {
            if (loadingTimeout) {
                clearTimeout(loadingTimeout);
            }
            window.removeEventListener("playlist-created", handlePlaylistEvent);
            window.removeEventListener("playlist-updated", handlePlaylistEvent);
            window.removeEventListener("playlist-deleted", handlePlaylistEvent);
        };
    }, [isAuthenticated, isMobileOrTablet]);

    // Close mobile menu on escape key
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") setIsMobileMenuOpen(false);
        };

        if (isMobileMenuOpen) {
            document.addEventListener("keydown", handleEscape);
            document.body.style.overflow = "hidden";
        }

        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = "unset";
        };
    }, [isMobileMenuOpen]);

    // Listen for toggle event from TopBar
    useEffect(() => {
        const handleToggle = () => setIsMobileMenuOpen(true);
        window.addEventListener("toggle-mobile-menu", handleToggle);
        return () =>
            window.removeEventListener("toggle-mobile-menu", handleToggle);
    }, []);

    // Close sort/filter popover on outside click
    useEffect(() => {
        if (!isSortFilterOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (
                sortFilterRef.current &&
                !sortFilterRef.current.contains(e.target as Node)
            ) {
                setIsSortFilterOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [isSortFilterOpen]);

    // Don't show sidebar on login/register pages
    // (Check after all hooks to comply with Rules of Hooks)
    if (pathname === "/login" || pathname === "/register") {
        return null;
    }

    // Merge local and (when federated) peer playlists into one filtered,
    // sorted spectrum. A stored "peers" filter degrades to "all" if the
    // federation feature is off so the list never renders empty and stuck.
    const effectiveFilter =
        !federation && playlistFilter === "peers" ? "all" : playlistFilter;
    const filteredSortedPlaylists = buildUnifiedPlaylistRows(
        playlists,
        federation ? peerPlaylists : [],
        { filter: effectiveFilter, sort: playlistSort },
    );

    const isFiltered = playlistFilter !== "all" || playlistSort !== "updated";

    // Render sidebar content inline to prevent component recreation
    const sidebarContent = (
        <>
            <nav
                className="px-3 pt-4"
                role="navigation"
                aria-label="Main navigation"
            >
                <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-content-muted">
                    Listen
                </p>
                <div className="space-y-1">
                    {SIDEBAR_NAVIGATION.map((item) => {
                        const isActive =
                            item.href === "/"
                                ? pathname === "/"
                                : pathname.startsWith(item.href);
                        const badge = "badge" in item ? item.badge : null;
                        const hasVibeAccent =
                            item.accent === "vibe" && !isActive;
                        const Icon =
                            sidebarNavigationIcons[
                                item.href as keyof typeof sidebarNavigationIcons
                            ];

                        return (
                            <Link
                                key={item.name}
                                href={item.href}
                                onClick={
                                    item.href === "/library"
                                        ? (event) => {
                                              handleOfflineLibraryNavigation({
                                                  isOnline: navigator.onLine,
                                                  preventDefault: () =>
                                                      event.preventDefault(),
                                                  hardNavigate: (path) =>
                                                      window.location.assign(
                                                          path,
                                                      ),
                                              });
                                          }
                                        : undefined
                                }
                                aria-current={isActive ? "page" : undefined}
                                className={cn(
                                    "group relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light",
                                    isActive
                                        ? "bg-white/[0.09] text-white"
                                        : "text-content-secondary hover:bg-white/[0.055] hover:text-white",
                                )}
                            >
                                {isActive ? (
                                    <span
                                        className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand-hover"
                                        aria-hidden="true"
                                    />
                                ) : null}
                                <Icon
                                    className={cn(
                                        "h-[18px] w-[18px] flex-shrink-0",
                                        hasVibeAccent && "text-ai-hover",
                                    )}
                                    strokeWidth={isActive ? 2.4 : 2}
                                />
                                <span>{item.name}</span>
                                {badge && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-brand/20 text-brand border border-brand/30">
                                        {badge}
                                    </span>
                                )}
                            </Link>
                        );
                    })}
                </div>
            </nav>

            {/* Playlists Section */}
            <div
                className={cn(
                    "flex-1 overflow-hidden flex flex-col",
                    isMobileOrTablet ? "mt-8" : "mt-4",
                )}
            >
                <div
                    className={cn(
                        "flex items-center justify-between group",
                        isMobileOrTablet ? "mb-4 px-6" : "mb-2 px-3",
                    )}
                >
                    <Link
                        href="/playlists"
                        prefetch={false}
                        className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                    >
                        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-content-muted transition-colors hover:text-white">
                            {effectiveFilter === "others"
                                ? "Shared playlists"
                                : effectiveFilter === "mine"
                                  ? "Your playlists"
                                  : effectiveFilter === "peers"
                                    ? "Peer playlists"
                                    : "All playlists"}
                        </span>
                    </Link>
                    <div className="flex items-center gap-1">
                        <div ref={sortFilterRef} className="relative">
                            <button
                                ref={sortFilterBtnRef}
                                onClick={() => {
                                    setIsSortFilterOpen((v) => {
                                        if (!v && sortFilterBtnRef.current) {
                                            const rect =
                                                sortFilterBtnRef.current.getBoundingClientRect();
                                            setSortFilterPos({
                                                top: rect.top,
                                                left: rect.right + 8,
                                            });
                                        }
                                        return !v;
                                    });
                                }}
                                className={cn(
                                    "flex h-9 w-9 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light",
                                    isFiltered
                                        ? "border-brand/40 bg-brand/15 text-brand-light"
                                        : "border-white/5 bg-white/[0.04] text-content-muted hover:border-white/10 hover:bg-white/[0.07] hover:text-white",
                                )}
                                aria-label="Sort and filter playlists"
                                title="Sort & Filter"
                            >
                                <ArrowUpDown className="h-4 w-4" />
                            </button>

                            {isSortFilterOpen && sortFilterPos && (
                                <div
                                    className="fixed w-44 bg-surface-hover border border-white/10 rounded-lg shadow-xl shadow-black/40 py-1 z-[10000]"
                                    style={{
                                        top: sortFilterPos.top,
                                        left: sortFilterPos.left,
                                    }}
                                >
                                    <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                                        Sort
                                    </div>
                                    {(
                                        [
                                            ["updated", "Updated date"],
                                            ["created", "Created date"],
                                            ["alphabetical", "Alphabetical"],
                                        ] as const
                                    ).map(([value, label]) => (
                                        <button
                                            key={value}
                                            onClick={() =>
                                                setPlaylistSort(value)
                                            }
                                            className={cn(
                                                "w-full text-left px-3 py-1.5 text-sm transition-colors",
                                                playlistSort === value
                                                    ? "text-white bg-white/5"
                                                    : "text-gray-400 hover:text-white hover:bg-white/5",
                                            )}
                                        >
                                            {label}
                                        </button>
                                    ))}

                                    <div className="mx-2 my-1 border-t border-white/10" />

                                    <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                                        Show
                                    </div>
                                    {playlistFilterOptions(federation).map(
                                        ([value, label]) => (
                                            <button
                                                key={value}
                                                onClick={() =>
                                                    setPlaylistFilter(value)
                                                }
                                                className={cn(
                                                    "w-full text-left px-3 py-1.5 text-sm transition-colors",
                                                    playlistFilter === value
                                                        ? "text-white bg-white/5"
                                                        : "text-gray-400 hover:text-white hover:bg-white/5",
                                                )}
                                            >
                                                {label}
                                            </button>
                                        ),
                                    )}
                                </div>
                            )}
                        </div>

                        <Link
                            href="/playlists"
                            prefetch={false}
                            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/5 bg-white/[0.04] text-content-muted transition-colors hover:border-white/10 hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                            aria-label="Create playlist"
                            title="Create Playlist"
                        >
                            <Plus className="w-4 h-4" />
                        </Link>
                    </div>
                </div>
                <div
                    className={cn(
                        "flex-1 overflow-y-auto space-y-1 scrollbar-thin scrollbar-track-transparent",
                        isMobileOrTablet ? "px-6" : "px-3",
                    )}
                >
                    {/* Pinned: My Liked */}
                    {likedTotal > 0 &&
                        (() => {
                            const isLikedActive =
                                pathname === "/playlist/my-liked";
                            return (
                                <Link
                                    href="/playlist/my-liked"
                                    prefetch={false}
                                    className={cn(
                                        "group block rounded-xl border px-3 py-2.5 transition-colors",
                                        isLikedActive
                                            ? "border-brand/25 bg-brand/10 text-white"
                                            : "border-transparent text-content-secondary hover:border-white/5 hover:bg-white/[0.045] hover:text-white",
                                    )}
                                >
                                    <div className="flex items-center gap-1.5">
                                        <Heart className="w-3.5 h-3.5 shrink-0 text-brand fill-brand relative z-10" />
                                        <div
                                            className={cn(
                                                "relative z-10 flex-1 truncate text-sm font-medium",
                                                isLikedActive
                                                    ? "font-semibold"
                                                    : "",
                                            )}
                                        >
                                            My Liked
                                        </div>
                                    </div>
                                    <div
                                        className={cn(
                                            "text-xs truncate relative z-10 mt-0.5 transition-colors duration-200",
                                            isLikedActive
                                                ? "text-gray-400"
                                                : "text-gray-400 group-hover:text-gray-400",
                                        )}
                                    >
                                        Playlist &bull; {likedTotal} track
                                        {likedTotal !== 1 ? "s" : ""}
                                    </div>
                                </Link>
                            );
                        })()}
                    {isLoadingPlaylists ? (
                        // Loading skeleton with shimmer
                        <>
                            {[1, 2, 3, 4, 5].map((i) => (
                                <div
                                    key={i}
                                    className="px-3 py-2.5 rounded-lg relative overflow-hidden bg-white/[0.02] border-l-2 border-transparent"
                                >
                                    <div className="h-4 bg-white/5 rounded w-3/4 mb-2 relative"></div>
                                    <div className="h-3 bg-white/5 rounded w-1/2 relative"></div>
                                </div>
                            ))}
                        </>
                    ) : filteredSortedPlaylists.length > 0 ? (
                        filteredSortedPlaylists.map((playlist) => {
                            const isActive = pathname === playlist.href;
                            const isShared =
                                playlist.kind === "local" && !playlist.isOwner;
                            return (
                                <Link
                                    key={playlist.key}
                                    href={playlist.href}
                                    prefetch={false}
                                    className={cn(
                                        "group block rounded-xl border px-3 py-2.5 transition-colors",
                                        isActive
                                            ? "border-brand/25 bg-brand/10 text-white"
                                            : "border-transparent text-content-secondary hover:border-white/5 hover:bg-white/[0.045] hover:text-white",
                                    )}
                                >
                                    <div className="flex items-center gap-1.5">
                                        <div
                                            className={cn(
                                                "relative z-10 flex-1 truncate text-sm font-medium",
                                                isActive ? "font-semibold" : "",
                                            )}
                                        >
                                            {playlist.name}
                                        </div>
                                        {playlist.kind === "peer" && (
                                            <PeerBadge
                                                peerName={playlist.peerName}
                                                online={true}
                                                className="relative z-10 shrink-0"
                                            />
                                        )}
                                        {isShared && (
                                            <span
                                                className="shrink-0 w-1.5 h-1.5 rounded-full bg-ai"
                                                title={`Shared by ${
                                                    playlist.ownerName ||
                                                    "someone"
                                                }`}
                                            />
                                        )}
                                    </div>
                                    <div
                                        className={cn(
                                            "text-xs truncate relative z-10 mt-0.5 transition-colors duration-200",
                                            isActive
                                                ? "text-gray-400"
                                                : "text-gray-400 group-hover:text-gray-400",
                                        )}
                                    >
                                        {playlist.kind === "peer" || isShared
                                            ? `by ${
                                                  playlist.ownerName || "Shared"
                                              }`
                                            : "Playlist"}{" "}
                                        • {playlist.trackCount} track
                                        {playlist.trackCount !== 1 ? "s" : ""}
                                    </div>
                                </Link>
                            );
                        })
                    ) : (
                        <div className="px-4 py-8 text-center">
                            <div className="text-sm text-gray-400 mb-2">
                                {isFiltered
                                    ? "No matching playlists"
                                    : "No playlists yet"}
                            </div>
                            <div className="text-xs text-gray-400">
                                {isFiltered
                                    ? "Try changing your filter"
                                    : "Create your first playlist to get started"}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </>
    );

    return (
        <>
            {/* Mobile Sidebar */}
            {isMobileOrTablet && (
                <MobileSidebar
                    isOpen={isMobileMenuOpen}
                    onClose={() => setIsMobileMenuOpen(false)}
                    hasActiveSessions={hasActiveSessions}
                />
            )}

            {/* Desktop Sidebar */}
            {!isMobileOrTablet && (
                <aside
                    data-shell-sidebar="desktop"
                    className="shell-sidebar relative z-10 flex w-[224px] flex-shrink-0 flex-col overflow-hidden"
                >
                    {sidebarContent}
                </aside>
            )}
        </>
    );
}
