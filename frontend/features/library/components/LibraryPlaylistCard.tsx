import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { pluralRu } from "@/lib/i18n/ru";
import { cn } from "@/utils/cn";

interface LibraryPlaylistCardProps {
    href: string;
    title: string;
    trackCount: number;
    icon: LucideIcon;
    accent: "liked" | "downloaded";
}

/** Static playlist-shaped entry for account and device collections. */
export function LibraryPlaylistCard({
    href,
    title,
    trackCount,
    icon: Icon,
    accent,
}: LibraryPlaylistCardProps) {
    return (
        <Link
            href={href}
            data-library-static-playlist={accent}
            className="group min-w-0 rounded-[20px] border border-transparent p-2 transition-[transform,background-color,border-color] hover:-translate-y-0.5 hover:border-white/[0.08] hover:bg-white/[0.045] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none"
        >
            <div
                className={cn(
                    "mb-3 grid aspect-square place-items-center overflow-hidden rounded-[18px] shadow-[0_16px_42px_rgb(0_0_0/0.2)] ring-1 ring-white/[0.06]",
                    accent === "liked"
                        ? "bg-brand/20 text-brand-light"
                        : "bg-ai/15 text-ai-hover",
                )}
            >
                <Icon
                    className={cn(
                        "h-[30%] w-[30%]",
                        accent === "liked" && "fill-current",
                    )}
                    aria-hidden="true"
                />
            </div>
            <h3 className="line-clamp-2 min-h-10 text-sm font-bold leading-5 text-content [overflow-wrap:anywhere] sm:text-base">
                {title}
            </h3>
            <p className="mt-1 truncate text-xs text-content-muted">
                {trackCount} {pluralRu(trackCount, ["трек", "трека", "треков"])}
            </p>
        </Link>
    );
}
