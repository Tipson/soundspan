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
} from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useLikedPlaylistQuery } from "@/hooks/useQueries";
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

/** Compact desktop navigation and the mobile menu entry point. */
export function Sidebar() {
    const pathname = usePathname();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const likedQuery = useLikedPlaylistQuery(1);
    const likedTotal = likedQuery.data?.total ?? 0;
    const isLikedRoute = pathname === "/playlist/my-liked";
    const isPlaylistsRoute =
        pathname.startsWith("/playlists") ||
        (pathname.startsWith("/playlist/") && !isLikedRoute);

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
                className="mx-4 mt-5 border-t border-white/[0.08] pt-5"
            >
                <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-content-muted">
                    Библиотека
                </p>
                <div className="space-y-1">
                    <Link
                        href="/playlist/my-liked"
                        prefetch={false}
                        aria-current={isLikedRoute ? "page" : undefined}
                        className={cn(
                            "group flex min-h-12 items-center gap-3 rounded-xl px-3 text-content-secondary transition-colors duration-200 hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
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

                    <div className="flex items-center gap-1">
                        <Link
                            href="/playlists"
                            prefetch={false}
                            aria-current={isPlaylistsRoute ? "page" : undefined}
                            className={cn(
                                "group flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-sm font-semibold text-content-secondary transition-colors duration-200 hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                isPlaylistsRoute &&
                                    "bg-white/[0.085] text-white",
                            )}
                        >
                            <ListMusic
                                className="h-[18px] w-[18px] shrink-0"
                                aria-hidden="true"
                            />
                            <span>Плейлисты</span>
                        </Link>
                        <Link
                            href="/playlists?create=1"
                            prefetch={false}
                            aria-label={ru.nav.createPlaylist}
                            title={ru.nav.createPlaylist}
                            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-content-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            <Plus className="h-4 w-4" aria-hidden="true" />
                        </Link>
                    </div>
                </div>
            </div>

            <div className="mt-auto p-4">
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
