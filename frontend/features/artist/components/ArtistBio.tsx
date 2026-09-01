"use client";

import DOMPurify from "dompurify";
import { useMemo, useState } from "react";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { cn } from "@/utils/cn";
import { ru } from "@/lib/i18n/ru";

interface ArtistBioProps {
    bio: string;
}

/**
 * Renders the ArtistBio component.
 */
export function ArtistBio({ bio }: ArtistBioProps) {
    const safeBio = bio || "";
    const isMobile = useIsMobile();
    const [expandedBio, setExpandedBio] = useState<string | null>(null);
    const isExpanded = expandedBio === safeBio;

    const plainBio = useMemo(
        () =>
            safeBio
                .replace(/<[^>]*>/g, " ")
                .replace(/\s+/g, " ")
                .trim(),
        [safeBio],
    );
    const needsCollapse = isMobile && plainBio.length > 260;
    const shouldCollapse = needsCollapse && !isExpanded;

    if (!safeBio) return null;

    return (
        <section className="max-w-4xl border-t border-white/[0.08] pt-7">
            <h2 className="mb-4 text-2xl font-black tracking-[-0.03em] sm:text-3xl">
                {ru.catalog.about}
            </h2>
            <div>
                <div
                    className={cn(
                        "prose prose-sm md:prose-base prose-invert max-w-none leading-relaxed text-content-secondary [&_a]:text-brand [&_a]:no-underline [&_a:hover]:underline",
                        shouldCollapse && "max-h-28 overflow-hidden",
                    )}
                    dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(safeBio),
                    }}
                />
                {shouldCollapse && (
                    <div className="-mt-12 h-12 bg-gradient-to-t from-surface to-transparent" />
                )}
                {needsCollapse && !isExpanded && (
                    <button
                        type="button"
                        onClick={() => setExpandedBio(safeBio)}
                        className="mt-2 min-h-11 rounded-lg px-2 text-sm font-semibold text-brand transition-colors hover:bg-white/5 hover:text-brand-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    >
                        {ru.catalog.more}
                    </button>
                )}
            </div>
        </section>
    );
}
