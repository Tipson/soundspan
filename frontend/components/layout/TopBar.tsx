"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { Search, Menu, Bell, ChevronLeft } from "lucide-react";
import { ActivityPanelToggle } from "./ActivityPanel";
import { UserAvatarMenu } from "./UserAvatarMenu";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import Image from "next/image";

import { BRAND_NAME } from "@/lib/brand";

interface TopBarProps {
    isActivityPanelOpen?: boolean;
}

/**
 * Renders the TopBar component.
 */
export function TopBar({ isActivityPanelOpen = false }: TopBarProps = {}) {
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const routeSearchQuery =
        pathname === "/search" ? (searchParams.get("q") ?? "") : "";
    const routeSearchKey = `${pathname}\u0000${routeSearchQuery}`;
    const [searchDraft, setSearchDraft] = useState(() => ({
        routeKey: routeSearchKey,
        value: routeSearchQuery,
    }));
    const searchQuery =
        searchDraft.routeKey === routeSearchKey
            ? searchDraft.value
            : routeSearchQuery;
    const updateSearchQuery = (value: string) => {
        setSearchDraft({ routeKey: routeSearchKey, value });
    };
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        if (searchQuery.trim()) {
            router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
        }
    };

    // Auto-search with debounce (500ms after user stops typing)
    useEffect(() => {
        // Don't auto-search if we're already on the search page with the same query
        const params = new URLSearchParams(window.location.search);
        const currentQuery = params.get("q");
        if (pathname === "/search" && currentQuery === searchQuery.trim()) {
            return;
        }

        // Clear any existing timeout
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        // Don't search if query is empty
        if (!searchQuery.trim()) {
            return;
        }

        // Set new timeout to trigger search after 500ms of no typing
        searchTimeoutRef.current = setTimeout(() => {
            router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
        }, 500);

        // Cleanup timeout on unmount or when searchQuery changes
        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchQuery, router, pathname]);

    // Global "/" keyboard shortcut to focus search
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = (e.target as HTMLElement)?.tagName;
                if (
                    tag === "INPUT" ||
                    tag === "TEXTAREA" ||
                    (e.target as HTMLElement)?.isContentEditable
                ) {
                    return;
                }
                e.preventDefault();
                searchInputRef.current?.focus();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, []);

    return (
        <header
            data-shell-topbar={isMobileOrTablet ? "mobile" : "desktop"}
            className="shell-topbar pwa-titlebar-drag fixed inset-x-0 top-0 z-50 flex items-center"
            style={{
                height: isMobileOrTablet
                    ? "calc(var(--app-topbar-height) + var(--safe-area-top))"
                    : "var(--app-topbar-height-desktop)",
                paddingTop: isMobileOrTablet
                    ? "var(--safe-area-top)"
                    : undefined,
                paddingLeft: isMobileOrTablet
                    ? "calc(0.75rem + var(--safe-area-left))"
                    : undefined,
                paddingRight: isMobileOrTablet
                    ? "calc(0.75rem + var(--safe-area-right))"
                    : undefined,
            }}
        >
            {/* Mobile keeps only the three controls that earn the scarce width. */}
            {isMobileOrTablet ? (
                <>
                    <button
                        onClick={() => {
                            // Dispatch custom event to toggle mobile menu
                            window.dispatchEvent(
                                new CustomEvent("toggle-mobile-menu"),
                            );
                        }}
                        className="shell-control mr-2 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        aria-label="Open menu"
                    >
                        <Menu className="w-5 h-5" />
                    </button>

                    <form onSubmit={handleSearch} className="flex-1 min-w-0">
                        <div
                            className="group relative"
                            data-tv-section="search-input"
                        >
                            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted transition-colors group-focus-within:text-white" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) =>
                                    updateSearchQuery(e.target.value)
                                }
                                placeholder="Search music"
                                aria-label="Search"
                                autoCapitalize="none"
                                autoCorrect="off"
                                tabIndex={0}
                                className="shell-search-field h-11 w-full min-w-0 rounded-xl pl-10 pr-3 text-sm text-white outline-none placeholder:text-content-muted focus:ring-2 focus:ring-brand/15"
                            />
                        </div>
                    </form>

                    <button
                        onClick={() => {
                            window.dispatchEvent(
                                new CustomEvent("toggle-activity-panel"),
                            );
                        }}
                        className="shell-control relative ml-2 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-content-secondary hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        aria-label="Notifications"
                        title="Notifications"
                    >
                        <Bell className="w-5 h-5" />
                    </button>
                </>
            ) : (
                <>
                    <div className="flex w-[236px] flex-shrink-0 items-center px-3">
                        <Link
                            href="/"
                            className="group flex items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        >
                            <Image
                                src="/assets/images/soundspan.webp"
                                alt={BRAND_NAME}
                                width={38}
                                height={38}
                                sizes="38px"
                                className="transition-transform duration-200 group-hover:scale-[1.04]"
                            />
                            <span className="brand-wordmark text-[1.85rem] font-bold text-white">
                                {BRAND_NAME}
                            </span>
                        </Link>
                    </div>

                    <div className="flex min-w-0 flex-1 items-center justify-center px-4">
                        <div className="flex w-full max-w-[620px] items-center gap-2">
                            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center">
                                {pathname !== "/" ? (
                                    <button
                                        onClick={() => router.back()}
                                        className="flex h-11 w-11 items-center justify-center rounded-xl border border-transparent text-content-muted transition-colors hover:border-white/10 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                                        aria-label="Go back"
                                        title="Go back"
                                    >
                                        <ChevronLeft className="h-5 w-5" />
                                    </button>
                                ) : (
                                    <span
                                        className="h-11 w-11"
                                        aria-hidden="true"
                                    />
                                )}
                            </div>

                            <form
                                onSubmit={handleSearch}
                                className="min-w-0 flex-1"
                            >
                                <div
                                    className="group relative"
                                    data-tv-section="search-input"
                                >
                                    <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-content-muted transition-colors group-focus-within:text-white" />
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) =>
                                            updateSearchQuery(e.target.value)
                                        }
                                        placeholder="What do you want to play?"
                                        aria-label="Search"
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        tabIndex={0}
                                        className="shell-search-field h-12 w-full rounded-2xl pl-12 pr-14 text-sm text-white outline-none placeholder:text-content-muted focus:ring-2 focus:ring-brand/15"
                                    />
                                    <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[10px] font-semibold text-content-muted">
                                        /
                                    </kbd>
                                </div>
                            </form>
                        </div>
                    </div>

                    <div className="flex w-[236px] flex-shrink-0 items-center justify-end gap-2 px-3">
                        <ActivityPanelToggle
                            pollingEnabled={!isActivityPanelOpen}
                        />
                        <UserAvatarMenu />
                    </div>
                </>
            )}
        </header>
    );
}
