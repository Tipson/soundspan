import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

interface MusicDetailActionDockProps {
    children?: ReactNode;
    label: string;
    className?: string;
}

/** Shared translucent action surface for artist, album, and playlist pages. */
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
                "inline-flex min-h-14 w-full max-w-full flex-wrap items-center gap-2 rounded-[20px] border border-white/[0.09] bg-black/35 p-2 shadow-[0_18px_48px_rgb(0_0_0/0.22)] backdrop-blur-xl",
                "supports-[backdrop-filter]:bg-black/25 sm:w-fit",
                className,
            )}
        >
            {children}
        </div>
    );
}
