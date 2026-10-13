import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

interface MusicDetailActionDockProps {
    children?: ReactNode;
    label: string;
    className?: string;
}

/** Shared compact playback and secondary-action group for music detail pages. */
export function MusicDetailActionDock({
    children,
    label,
    className,
}: MusicDetailActionDockProps) {
    return (
        <div
            role="group"
            aria-label={label}
            data-music-detail="actions"
            className={cn(
                "inline-flex min-h-14 w-full max-w-full flex-wrap items-center gap-2 sm:w-fit",
                className,
            )}
        >
            {children}
        </div>
    );
}
