"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { Tab } from "../types";
import { cn } from "@/utils/cn";

interface LibraryTabsProps {
    activeTab: Tab;
}

const TABS: ReadonlyArray<{
    id: Tab | "liked";
    label: string;
    href: string;
}> = [
    { id: "overview", label: "Overview", href: "/library" },
    { id: "liked", label: "Liked songs", href: "/playlist/my-liked" },
    { id: "playlists", label: "Playlists", href: "/library?tab=playlists" },
    { id: "albums", label: "Albums", href: "/library?tab=albums" },
    { id: "artists", label: "Artists", href: "/library?tab=artists" },
    { id: "downloads", label: "Downloads", href: "/library?tab=downloads" },
];

/** Personal Library navigation; Liked songs keeps its dedicated playable page. */
export function LibraryTabs({ activeTab }: LibraryTabsProps) {
    const activeLinkRef = useRef<HTMLAnchorElement | null>(null);

    useEffect(() => {
        activeLinkRef.current?.scrollIntoView({
            block: "nearest",
            inline: "center",
        });
    }, [activeTab]);

    return (
        <nav
            aria-label="Library sections"
            data-tv-section="library-tabs"
            data-overflow-cue="horizontal"
            className="relative"
        >
            <span className="sr-only">
                Scroll horizontally for more Library sections
            </span>
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-surface to-transparent sm:hidden"
            />
            <div className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-2 pr-12 scroll-px-4 [scrollbar-width:none] sm:-mx-1 sm:px-1 sm:pr-1 [&::-webkit-scrollbar]:hidden">
                {TABS.map((tab, index) => {
                    const active = tab.id === activeTab;
                    return (
                        <Link
                            key={tab.id}
                            ref={active ? activeLinkRef : undefined}
                            href={tab.href}
                            data-tv-card
                            data-tv-card-index={index}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                                "inline-flex min-h-11 shrink-0 snap-start items-center rounded-full px-4 py-2 text-sm font-semibold transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                active
                                    ? "bg-content text-surface"
                                    : "bg-white/[0.07] text-content-secondary hover:bg-white/10 hover:text-content",
                            )}
                        >
                            {tab.label}
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}
