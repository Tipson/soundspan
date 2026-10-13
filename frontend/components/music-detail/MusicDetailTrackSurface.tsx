import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

interface MusicDetailTrackSurfaceProps {
    children?: ReactNode;
    label: string;
    className?: string;
}

/** Canonical quiet surface for ordered, playable catalog rows. */
export function MusicDetailTrackSurface({
    children,
    label,
    className,
}: MusicDetailTrackSurfaceProps) {
    return (
        <section
            aria-label={label}
            data-music-detail="tracks"
            className={cn(
                "overflow-hidden rounded-[14px] bg-surface-raised/60 p-1 sm:p-2",
                className,
            )}
        >
            {children}
        </section>
    );
}
