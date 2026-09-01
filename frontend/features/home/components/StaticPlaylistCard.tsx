/**
 * Shared static playlist card matching MixCard visual style.
 *
 * Used by MadeForYouSection (explore) and the Home page "Made For You" row for
 * items like My Liked and Discover Weekly that are not generated mixes.
 */

import { memo, type ReactNode } from "react";
import Link from "next/link";
import { CachedImage } from "@/components/ui/CachedImage";

export interface StaticPlaylistCardProps {
    href: string;
    coverUrl: string | null;
    title: string;
    subtitle: string;
    placeholderIcon: ReactNode;
    /** Optional icon rendered in the bottom-right corner of the cover art. */
    overlayIcon?: ReactNode;
    index?: number;
}

/**
 * Renders a static playlist card matching MixCard visual style.
 */
export const StaticPlaylistCard = memo(function StaticPlaylistCard({
    href,
    coverUrl,
    title,
    subtitle,
    placeholderIcon,
    overlayIcon,
    index,
}: StaticPlaylistCardProps) {
    return (
        <Link
            href={href}
            data-tv-card
            data-tv-card-index={index}
            tabIndex={0}
            className="group block min-w-0 rounded-[1.125rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
            <div>
                <div className="relative mb-3 aspect-square overflow-hidden rounded-[1.125rem] bg-surface-highlight shadow-lg shadow-black/25">
                    {coverUrl ? (
                        <CachedImage
                            src={coverUrl}
                            alt={title}
                            fill
                            className="object-cover transition-transform duration-300 group-hover:scale-[1.035] motion-reduce:transition-none"
                            sizes="(max-width: 640px) 72vw, 190px"
                        />
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                            {placeholderIcon}
                        </div>
                    )}
                    {overlayIcon && (
                        <div className="absolute bottom-1.5 right-1.5 drop-shadow-lg">
                            {overlayIcon}
                        </div>
                    )}
                </div>
                <h3 className="truncate text-sm font-bold text-content sm:text-[0.9375rem]">
                    {title}
                </h3>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-content-muted">
                    {subtitle}
                </p>
            </div>
        </Link>
    );
});
