"use client";

import DOMPurify from "dompurify";
import { useMemo, useState } from "react";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { cn } from "@/utils/cn";

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
        <section className="max-w-4xl">
            <h2 className="mb-4 text-2xl font-black tracking-tight">About</h2>
            <div className="rounded-2xl border border-white/8 bg-white/[0.045] p-5 sm:p-6">
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
                    <div className="-mt-12 h-12 bg-gradient-to-t from-surface-elevated to-transparent" />
                )}
                {needsCollapse && !isExpanded && (
                    <button
                        type="button"
                        onClick={() => setExpandedBio(safeBio)}
                        className="mt-2 text-sm text-brand hover:underline"
                    >
                        ...more
                    </button>
                )}
            </div>
        </section>
    );
}
