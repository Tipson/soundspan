"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
    AudioWaveform,
    Download,
    Heart,
    Home,
    Library,
    ListMusic,
    Plus,
    RotateCcw,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { BRAND_NAME } from "@/lib/brand";
import { useIsMobile, useIsTablet, useMediaQuery } from "@/hooks/useMediaQuery";
import {
    queryKeys,
    useLikedPlaylistQuery,
    usePlaylistsQuery,
} from "@/hooks/useQueries";
import { pluralRu, ru } from "@/lib/i18n/ru";
import { cn } from "@/utils/cn";
import { handleOfflineLibraryNavigation } from "./offlineLibraryNavigation";
import { MobileSidebar } from "./MobileSidebar";
import { SIDEBAR_NAVIGATION } from "./socialNavigation";

const sidebarNavigationIcons = {
    "/": Home,
    "/vibe": AudioWaveform,
    "/library": Library,
} as const;

const MAX_SIDEBAR_PLAYLISTS = 50;
const MAX_SHORT_SIDEBAR_PLAYLISTS = 1;

interface SidebarPlaylist {
    id: string;
    name: string;
    trackCount?: number;
    items?: unknown[];
    isHidden?: boolean;
    isOwner?: boolean;
}

/** Compact desktop navigation and the mobile menu entry point. */
export function Sidebar() {
    const pathname = usePathname();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setIsMobileMenuOpen(false);
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

    useEffect(() => {
        const handleToggle = () => setIsMobileMenuOpen(true);
        window.addEventListener("toggle-mobile-menu", handleToggle);
        return () =>
            window.removeEventListener("toggle-mobile-menu", handleToggle);
    }, []);

    if (pathname === "/login" || pathname === "/register") return null;

    if (isMobileOrTablet) {
        return (
            <MobileSidebar
                isOpen={isMobileMenuOpen}
                onClose={() => setIsMobileMenuOpen(false)}
                hasActiveSessions={false}
            />
        );
    }

    return <DesktopSidebarContents pathname={pathname} />;
}

function DesktopSidebarContents({ pathname }: { pathname: string }) {
    const queryClient = useQueryClient();
    const isShortDesktop = useMediaQuery("(max-height: 850px)");
    const likedQuery = useLikedPlaylistQuery(1);
    const playlistsQuery = usePlaylistsQuery();
    const likedTotal = likedQuery.data?.total ?? 0;
    const isLikedRoute = pathname === "/playlist/my-liked";
    const visiblePersonalPlaylists = (
        Array.isArray(playlistsQuery.data)
            ? (playlistsQuery.data as SidebarPlaylist[])
            : []
    ).filter((playlist) => !playlist.isHidden && playlist.isOwner !== false);
    const personalPlaylists = visiblePersonalPlaylists.slice(
        0,
        isShortDesktop ? MAX_SHORT_SIDEBAR_PLAYLISTS : MAX_SIDEBAR_PLAYLISTS,
    );
    const hiddenPlaylistShortcutCount =
        visiblePersonalPlaylists.length - personalPlaylists.length;

    useEffect(() => {
        const refreshPlaylists = () => {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
        };
        const playlistEvents = [
            "playlist-created",
            "playlist-updated",
            "playlist-deleted",
        ] as const;

        for (const eventName of playlistEvents) {
            window.addEventListener(eventName, refreshPlaylists);
        }
        return () => {
            for (const eventName of playlistEvents) {
                window.removeEventListener(eventName, refreshPlaylists);
            }
        };
    }, [queryClient]);

    return (
        <aside
            data-shell-sidebar="desktop"
            className="shell-sidebar relative z-10 flex w-[248px] flex-shrink-0 flex-col overflow-hidden"
        >
            <Link
                href="/"
                className="group flex h-[88px] shrink-0 items-center gap-2.5 px-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-light"
                aria-label={`${BRAND_NAME} — ${ru.nav.home}`}
            >
                <Image
                    src="/assets/images/soundspan.webp"
                    alt=""
                    width={34}
                    height={34}
                    sizes="34px"
                    className="transition-transform duration-200 group-hover:scale-[1.04] motion-reduce:transition-none"
                />
                <span className="brand-wordmark text-[1.65rem] font-bold text-white">
                    {BRAND_NAME}
                </span>
            </Link>

            <nav
                data-shell-navigation="primary"
                className="px-3 pt-1"
                aria-label={ru.nav.mainAria}
            >
                <div className="space-y-1">
                    {SIDEBAR_NAVIGATION.map((item) => {
                        const isActive =
                            item.href === "/"
                                ? pathname === "/"
                                : pathname.startsWith(item.href);
                        const Icon =
                            sidebarNavigationIcons[
                                item.href as keyof typeof sidebarNavigationIcons
                            ];
                        return (
                            <Link
                                key={item.href}
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
                                    "shell-sidebar-link group relative flex min-h-11 items-center gap-3 rounded-xl px-4 text-sm font-semibold transition-[background-color,color,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light active:scale-[0.985] motion-reduce:transition-none",
                                    isActive
                                        ? "bg-white/[0.085] text-white"
                                        : "text-content-secondary hover:bg-white/[0.05] hover:text-white",
                                )}
                            >
                                <Icon
                                    className={cn(
                                        "h-[19px] w-[19px] shrink-0",
                                        item.accent === "vibe" &&
                                            !isActive &&
                                            "text-ai-hover",
                                    )}
                                    strokeWidth={isActive ? 2.35 : 1.9}
                                    aria-hidden="true"
                                />
                                <span>{item.name}</span>
                            </Link>
                        );
                    })}
                </div>
            </nav>

            <div
                data-shell-library-shortcuts="compact"
                className="mx-4 mt-5 flex min-h-0 flex-1 flex-col border-t border-white/[0.08] pt-5"
            >
                <p className="mb-2 shrink-0 px-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-content-muted">
                    Библиотека
                </p>
                <div className="flex min-h-0 flex-1 flex-col gap-1">
                    <Link
                        href="/playlist/my-liked"
                        prefetch={false}
                        aria-current={isLikedRoute ? "page" : undefined}
                        className={cn(
                            "group flex min-h-12 shrink-0 items-center gap-3 rounded-xl px-3 text-content-secondary transition-colors duration-200 hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                            isLikedRoute && "bg-white/[0.085] text-white",
                        )}
                    >
                        <Heart
                            className="h-[18px] w-[18px] shrink-0 text-ai-hover"
                            aria-hidden="true"
                        />
                        <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">
                                {ru.library.likedSongs}
                            </span>
                            <span className="block truncate text-[11px] text-content-muted">
                                {likedTotal > 0
                                    ? `${likedTotal} ${pluralRu(likedTotal, ["трек", "трека", "треков"])}`
                                    : "Ваши любимые треки"}
                            </span>
                        </span>
                    </Link>

                    <nav
                        data-shell-playlist-list="personal"
                        aria-label="Ваши плейлисты"
                        aria-busy={playlistsQuery.isLoading}
                        className="scrollbar-hide min-h-0 flex-1 space-y-1 overflow-y-auto py-1"
                    >
                        {playlistsQuery.isError ? (
                            <div
                                role="alert"
                                className="mx-1 rounded-xl border border-warning/20 bg-warning/[0.07] px-3 py-2.5"
                            >
                                <p className="text-[11px] leading-4 text-content-muted">
                                    Не удалось загрузить плейлисты
                                </p>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void playlistsQuery.refetch();
                                    }}
                                    className="mt-1.5 inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning motion-reduce:transition-none"
                                >
                                    <RotateCcw
                                        className="h-3.5 w-3.5"
                                        aria-hidden="true"
                                    />
                                    Повторить
                                </button>
                            </div>
                        ) : (
                            personalPlaylists.map((playlist) => {
                                const isActive =
                                    pathname ===
                                    `/playlist/${encodeURIComponent(playlist.id)}`;
                                const trackCount =
                                    playlist.trackCount ??
                                    playlist.items?.length ??
                                    0;

                                return (
                                    <Link
                                        key={playlist.id}
                                        href={`/playlist/${encodeURIComponent(playlist.id)}`}
                                        data-shell-playlist-shortcut="personal"
                                        prefetch={false}
                                        aria-current={
                                            isActive ? "page" : undefined
                                        }
                                        title={playlist.name}
                                        className={cn(
                                            "group flex min-h-12 items-center gap-3 rounded-xl px-3 text-content-secondary transition-colors duration-200 hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                            isActive &&
                                                "bg-white/[0.085] text-white",
                                        )}
                                    >
                                        <ListMusic
                                            className="h-[18px] w-[18px] shrink-0 text-content-muted group-hover:text-content-secondary"
                                            aria-hidden="true"
                                        />
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-semibold">
                                                {playlist.name}
                                            </span>
                                            <span className="block truncate text-[11px] text-content-muted">
                                                {trackCount}{" "}
                                                {pluralRu(trackCount, [
                                                    "трек",
                                                    "трека",
                                                    "треков",
                                                ])}
                                            </span>
                                        </span>
                                    </Link>
                                );
                            })
                        )}
                    </nav>

                    {hiddenPlaylistShortcutCount > 0 && (
                        <Link
                            href="/playlists"
                            prefetch={false}
                            data-shell-playlist-overflow="true"
                            className="group flex min-h-11 shrink-0 items-center gap-3 rounded-xl px-3 text-xs font-semibold text-content-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            <ListMusic
                                className="h-[18px] w-[18px] shrink-0"
                                aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate">
                                Все плейлисты
                            </span>
                            <span className="text-[10px] tabular-nums text-content-muted">
                                +{hiddenPlaylistShortcutCount}
                            </span>
                        </Link>
                    )}

                    <Link
                        href="/playlists?create=1"
                        prefetch={false}
                        aria-label={ru.nav.createPlaylist}
                        className="group flex min-h-11 shrink-0 items-center gap-3 rounded-xl px-3 text-xs font-semibold text-content-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    >
                        <Plus
                            className="h-[18px] w-[18px] shrink-0"
                            aria-hidden="true"
                        />
                        <span>{ru.nav.createPlaylist}</span>
                    </Link>
                </div>
            </div>

            <div className="shrink-0 p-4">
                <button
                    type="button"
                    onClick={() =>
                        window.dispatchEvent(
                            new CustomEvent("request-pwa-install"),
                        )
                    }
                    className="flex min-h-11 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-white/15 bg-white/[0.025] px-2 text-[11px] font-semibold text-content-secondary transition-colors duration-200 hover:border-white/25 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                >
                    <Download className="h-4 w-4" aria-hidden="true" />
                    Установить приложение
                </button>
            </div>
        </aside>
    );
}
