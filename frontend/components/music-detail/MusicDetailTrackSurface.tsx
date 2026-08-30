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
                "overflow-hidden rounded-[20px] border border-white/[0.08] bg-surface-raised/80 shadow-[0_24px_72px_rgb(0_0_0/0.16)]",
                className,
            )}
        >
            {children}
        </section>
    );
}
