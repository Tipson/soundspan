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
            className="relative rounded-[20px] border border-white/[0.08] bg-black/30 p-2 shadow-[0_18px_48px_rgb(0_0_0/0.2)] backdrop-blur-xl"
        >
            <span className="sr-only">
                Scroll horizontally for more Library sections
            </span>
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-2 right-2 z-10 w-10 rounded-r-xl bg-gradient-to-l from-surface-raised to-transparent sm:hidden"
            />
            <div className="flex snap-x snap-mandatory gap-1.5 overflow-x-auto pr-12 scroll-px-2 [scrollbar-width:none] sm:pr-0 [&::-webkit-scrollbar]:hidden">
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
                                "inline-flex min-h-11 shrink-0 snap-start items-center rounded-xl border px-4 py-2 text-sm font-semibold transition-colors active:scale-[0.98]",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                active
                                    ? "border-brand/45 bg-brand/18 text-content shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]"
                                    : "border-transparent text-content-secondary hover:bg-white/[0.07] hover:text-content",
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
