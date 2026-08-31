"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { cn } from "@/utils/cn";
import { ru } from "@/lib/i18n/ru";

export type LibraryTab =
    | "liked"
    | "playlists"
    | "albums"
    | "artists"
    | "downloads";

interface LibraryTabsProps {
    activeTab: LibraryTab;
}

const TABS: ReadonlyArray<{
    id: LibraryTab;
    label: string;
    href: string;
}> = [
    { id: "liked", label: "Лайкнутые", href: "/library?tab=liked" },
    {
        id: "playlists",
        label: ru.library.playlists,
        href: "/library?tab=playlists",
    },
    { id: "albums", label: ru.library.albums, href: "/library?tab=albums" },
    { id: "artists", label: ru.library.artists, href: "/library?tab=artists" },
    {
        id: "downloads",
        label: ru.library.downloads,
        href: "/library?tab=downloads",
    },
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
            aria-label={ru.library.sectionsAria}
            data-tv-section="library-tabs"
            data-library-tabs="collection"
            data-overflow-cue="horizontal"
            className="relative border-y border-white/[0.08]"
        >
            <span className="sr-only">{ru.library.sectionsHint}</span>
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-px right-0 z-10 w-10 bg-gradient-to-l from-surface to-transparent sm:hidden"
            />
            <div className="flex snap-x snap-mandatory gap-1 overflow-x-auto pr-12 scroll-px-1 [scrollbar-width:none] sm:pr-0 [&::-webkit-scrollbar]:hidden">
                {TABS.map((tab, index) => {
                    const active = tab.id === activeTab;
                    return (
                        <Link
                            key={tab.id}
                            ref={active ? activeLinkRef : undefined}
                            href={tab.href}
                            data-tv-card
                            data-tv-card-index={index}
                            data-library-tab={tab.id}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                                "relative inline-flex min-h-11 shrink-0 snap-start items-center px-4 py-2 text-sm font-semibold transition-colors active:scale-[0.98]",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                active
                                    ? "text-content after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-light"
                                    : "text-content-secondary hover:bg-white/[0.05] hover:text-content",
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
