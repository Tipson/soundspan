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
            onClick={
                href === "/library?tab=downloads"
                    ? (event) => {
                          if (
                              event.button !== 0 ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                          )
                              return;
                          event.preventDefault();
                          // This collection is already part of the mounted library page.
                          window.history.pushState(null, "", href);
                      }
                    : undefined
            }
            data-library-static-playlist={accent}
            className="group min-w-0 rounded-[14px] p-2 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none"
        >
            <div
                className={cn(
                    "mb-3 grid aspect-square place-items-center overflow-hidden rounded-[14px]",
                    accent === "liked"
                        ? "bg-brand/20 text-brand-light"
                        : "bg-surface-active text-content-secondary",
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
            <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-content [overflow-wrap:anywhere] sm:text-base">
                {title}
            </h3>
            <p className="mt-1 truncate text-xs text-content-muted">
                {trackCount} {pluralRu(trackCount, ["трек", "трека", "треков"])}
            </p>
        </Link>
    );
}
