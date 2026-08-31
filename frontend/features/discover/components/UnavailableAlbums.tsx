import { useState } from "react";
import { Play, Pause, Music, ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/utils/cn";
import { UnavailableAlbum } from "../types";
import { discoverAlbumCount, discoverRu } from "@/lib/i18n/discoverRu";

const tierColors: Record<string, string> = {
    high: "text-success",
    medium: "text-warning",
    explore: "text-brand",
    wildcard: "text-ai-hover",
    // Legacy mappings
    low: "text-brand",
    wild: "text-ai-hover",
};

const tierLabels: Record<string, string> = {
    high: discoverRu.tiers.high,
    medium: discoverRu.tiers.medium,
    explore: discoverRu.tiers.explore,
    wildcard: discoverRu.tiers.wildcard,
    // Legacy mappings
    low: discoverRu.tiers.explore,
    wild: discoverRu.tiers.wildcard,
};

interface UnavailableAlbumsProps {
    unavailable: UnavailableAlbum[];
    currentPreview: string | null;
    onTogglePreview: (albumId: string, previewUrl: string) => void;
}

/**
 * Renders the UnavailableAlbums component.
 */
export function UnavailableAlbums({
    unavailable,
    currentPreview,
    onTogglePreview,
}: UnavailableAlbumsProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    if (!unavailable || unavailable.length === 0) {
        return null;
    }

    return (
        <Card className="overflow-hidden rounded-2xl border-line bg-surface-elevated p-0">
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex min-h-11 w-full items-center justify-between rounded-2xl p-4 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover"
                aria-expanded={isExpanded}
            >
                <div className="flex items-center gap-2">
                    <Music className="size-5 text-brand" aria-hidden="true" />
                    <span className="text-sm font-medium text-content-muted">
                        {discoverAlbumCount(unavailable.length)}
                    </span>
                </div>
                {isExpanded ? (
                    <ChevronUp className="size-4 text-content-muted" />
                ) : (
                    <ChevronDown className="size-4 text-content-muted" />
                )}
            </button>
            {isExpanded && (
                <>
                    <div className="px-5 pb-4 sm:px-6">
                        <p className="text-sm leading-6 text-content-muted">
                            {discoverRu.unavailable.description}
                        </p>
                    </div>
                    <div className="divide-y divide-line">
                        {unavailable.map((album) => {
                            const isPreviewPlaying =
                                currentPreview === album.id;
                            const attemptLabel =
                                album.attemptNumber === 0
                                    ? discoverRu.unavailable.original
                                    : `${discoverRu.unavailable.replacement} №${album.attemptNumber}`;

                            return (
                                <div
                                    key={album.id}
                                    className={cn(
                                        "group flex items-center gap-3 px-3 py-3 transition-colors hover:bg-surface-hover sm:gap-4 sm:px-4",
                                        (album.attemptNumber ?? 0) > 0 &&
                                            "bg-surface-hover/30 sm:pl-12",
                                    )}
                                >
                                    <div className="flex size-11 shrink-0 items-center justify-center">
                                        {album.previewUrl ? (
                                            <button
                                                onClick={() =>
                                                    onTogglePreview(
                                                        album.id,
                                                        album.previewUrl!,
                                                    )
                                                }
                                                className="flex size-11 items-center justify-center rounded-full text-brand transition-colors hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover"
                                                aria-label={
                                                    isPreviewPlaying
                                                        ? `Поставить фрагмент «${album.album}» на паузу`
                                                        : `Воспроизвести фрагмент «${album.album}»`
                                                }
                                            >
                                                {isPreviewPlaying ? (
                                                    <Pause className="size-4 fill-current" />
                                                ) : (
                                                    <Play className="ml-0.5 size-4 fill-current" />
                                                )}
                                            </button>
                                        ) : (
                                            <Music className="size-4 text-content-muted" />
                                        )}
                                    </div>

                                    <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-line bg-surface">
                                        <Music className="size-6 text-content-disabled" />
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <h3 className="truncate text-sm font-semibold text-content">
                                            {album.album}
                                        </h3>
                                        <div className="flex items-center gap-2 truncate text-xs text-content-muted">
                                            <span>{album.artist}</span>
                                            {album.previewUrl && (
                                                <>
                                                    <span>•</span>
                                                    <span className="text-brand">
                                                        {
                                                            discoverRu
                                                                .unavailable
                                                                .preview
                                                        }
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    <div className="hidden md:flex items-center gap-2">
                                        <span
                                            className={cn(
                                                "rounded-full border border-line bg-surface px-2 py-1 text-xs font-medium",
                                                tierColors[album.tier],
                                            )}
                                        >
                                            {tierLabels[album.tier]}
                                        </span>
                                    </div>

                                    <div className="hidden items-center gap-2 sm:flex">
                                        <span
                                            className={cn(
                                                "px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap",
                                                album.attemptNumber === 0
                                                    ? "border border-warning/30 bg-warning/10 text-warning"
                                                    : "border border-ai/30 bg-ai/10 text-ai-hover",
                                            )}
                                        >
                                            {attemptLabel}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </Card>
    );
}
