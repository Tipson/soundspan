"use client";

import Link from "next/link";
import { Book, CheckCircle } from "lucide-react";
import { CachedImage } from "./CachedImage";
import { PeerBadge } from "./PeerBadge";

interface AudiobookCardProps {
    id: string;
    title: string;
    author: string;
    coverUrl?: string | null;
    progress?: {
        progress: number;
        isFinished: boolean;
    } | null;
    seriesBadge?: string; // e.g., "5 books" for series cards
    peer?: { name: string; online: boolean } | null;
    index?: number;
    getCoverUrl: (url: string) => string | null;
}

/**
 * Renders the AudiobookCard component.
 */
export function AudiobookCard({
    id,
    title,
    author,
    coverUrl,
    progress,
    seriesBadge,
    peer = null,
    index = 0,
    getCoverUrl,
}: AudiobookCardProps) {
    const resolvedCoverUrl = coverUrl ? getCoverUrl(coverUrl) : null;

    return (
        <Link
            href={
                seriesBadge
                    ? `/audiobooks/series/${encodeURIComponent(title)}`
                    : `/audiobooks/${id}`
            }
            data-audiobook-card="open"
            data-tv-card
            data-tv-card-index={index}
            className="group block rounded-xl transition duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none"
        >
            <div className="relative flex h-full cursor-pointer flex-col p-1.5 sm:p-2">
                {/* Book Cover Container - Fixed Aspect Ratio */}
                <div className="relative flex-shrink-0">
                    <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-linear-to-br from-surface-highlight to-surface-elevated shadow-2xl shadow-black/20">
                        {resolvedCoverUrl ? (
                            <CachedImage
                                src={resolvedCoverUrl}
                                alt={title}
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onError={(e) => {
                                    e.currentTarget.style.display = "none";
                                }}
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Book className="h-16 w-16 text-content-muted" />
                            </div>
                        )}

                        {/* Book Spine Shadow */}
                        <div className="pointer-events-none absolute bottom-0 left-0 top-0 w-2 bg-linear-to-r from-surface-sunken/60 to-transparent" />

                        {/* Book Gloss */}
                        <div className="pointer-events-none absolute inset-0 bg-linear-to-br from-content/5 via-transparent to-surface-sunken/25" />

                        {/* Progress Bar */}
                        {progress && !progress.isFinished && (
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-surface-sunken/80">
                                <div
                                    className="h-full bg-brand"
                                    style={{ width: `${progress.progress}%` }}
                                />
                            </div>
                        )}

                        {/* Completion Badge */}
                        {progress?.isFinished && (
                            <div className="absolute right-2 top-2 rounded-full bg-success p-1.5 shadow-lg">
                                <CheckCircle className="h-3 w-3 text-surface" />
                            </div>
                        )}

                        {/* Series Badge (for series cards only) */}
                        {seriesBadge && (
                            <div className="absolute right-2 top-2 rounded-lg bg-brand px-2 py-1 text-xs font-bold text-surface shadow-lg">
                                {seriesBadge}
                            </div>
                        )}

                        {/* Peer Provenance Badge */}
                        {peer && (
                            <div className="absolute bottom-2 left-2">
                                <PeerBadge
                                    peerName={peer.name}
                                    online={peer.online}
                                />
                            </div>
                        )}
                    </div>

                    {/* Shelf Shadow */}
                    <div className="absolute -bottom-1 left-0 right-0 h-2 rounded-b-xl bg-linear-to-b from-surface-hover/50 to-transparent" />
                </div>

                {/* Text Container - Fixed Height for Uniformity */}
                <div className="mt-3 flex h-14 flex-col justify-start px-1">
                    <h3 className="line-clamp-2 text-sm font-bold leading-tight text-content">
                        {title}
                    </h3>
                    <p className="mt-1 line-clamp-1 text-xs text-content-muted">
                        {author}
                    </p>
                </div>
            </div>
        </Link>
    );
}
