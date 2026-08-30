"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AudioWaveform, Home, Search, Library } from "lucide-react";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { handleOfflineLibraryNavigation } from "./offlineLibraryNavigation";

const navigationItems = [
    {
        name: "Home",
        href: "/",
        icon: Home,
        matchPattern: "/",
        exact: true,
    },
    {
        name: "Search",
        href: "/search",
        icon: Search,
        matchPattern: "/search",
    },
    {
        name: "Vibe",
        href: "/vibe",
        icon: AudioWaveform,
        matchPattern: "/vibe",
    },
    {
        name: "Library",
        href: "/library",
        icon: Library,
        matchPattern: "/library",
    },
];

/**
 * Renders the BottomNavigation component.
 */
export function BottomNavigation() {
    const pathname = usePathname();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    // Only render on mobile/tablet
    if (!isMobileOrTablet) return null;

    return (
        <nav
            data-shell-bottom-navigation="true"
            className="mobile-bottom-navigation fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08]"
            role="navigation"
            aria-label="Main navigation"
            style={{
                paddingBottom: "var(--safe-area-bottom)",
            }}
        >
            <div
                className="flex h-[var(--app-bottom-nav-height)] items-center justify-around px-1"
                style={{
                    paddingLeft: "var(--safe-area-left)",
                    paddingRight: "var(--safe-area-right)",
                }}
            >
                {navigationItems.map((item) => {
                    const isActive = item.exact
                        ? pathname === item.matchPattern
                        : pathname.startsWith(item.matchPattern);
                    const Icon = item.icon;

                    return (
                        <Link
                            key={item.name}
                            href={item.href}
                            onClick={
                                item.name === "Library"
                                    ? (event) => {
                                          handleOfflineLibraryNavigation({
                                              isOnline: navigator.onLine,
                                              preventDefault: () =>
                                                  event.preventDefault(),
                                              hardNavigate: (path) =>
                                                  window.location.assign(path),
                                          });
                                      }
                                    : undefined
                            }
                            className={cn(
                                "group relative flex min-h-11 h-full flex-1 flex-col items-center justify-center gap-1 rounded-xl py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-light",
                                isActive
                                    ? "text-white"
                                    : "text-content-muted active:text-content-secondary",
                            )}
                            aria-label={item.name}
                            aria-current={isActive ? "page" : undefined}
                        >
                            <span
                                className={cn(
                                    "flex h-7 min-w-10 items-center justify-center rounded-full px-2 transition-colors",
                                    isActive
                                        ? "bg-white/[0.1] text-white"
                                        : "group-active:bg-white/[0.05]",
                                )}
                            >
                                <Icon
                                    className="h-5 w-5"
                                    strokeWidth={isActive ? 2.5 : 2}
                                />
                            </span>
                            <span
                                className={cn(
                                    "text-[10px] leading-none tracking-wide",
                                    isActive ? "font-semibold" : "font-medium",
                                )}
                            >
                                {item.name}
                            </span>
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}
