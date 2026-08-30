import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/utils/cn";

type ArtworkShape = "round" | "square";

interface AmbientColors {
    vibrant?: string;
    darkVibrant?: string;
    darkMuted?: string;
}

interface MusicDetailHeroProps {
    eyebrow: string;
    title: ReactNode;
    artwork: ReactNode;
    artworkShape: ArtworkShape;
    metadata?: ReactNode;
    description?: ReactNode;
    titleAfter?: ReactNode;
    actions?: ReactNode;
    backgroundImage?: string | null;
    ambientColors?: AmbientColors | null;
    className?: string;
}

function ambientStyle(colors?: AmbientColors | null): CSSProperties {
    const top = colors?.vibrant ?? "var(--music-action)";
    const middle = colors?.darkVibrant ?? "var(--music-raised)";
    const bottom = colors?.darkMuted ?? "var(--music-canvas)";
    return {
        background: `linear-gradient(155deg, color-mix(in srgb, ${top} 38%, var(--music-stage)) 0%, color-mix(in srgb, ${middle} 52%, var(--music-stage)) 44%, ${bottom} 100%)`,
    };
}

/** Artwork-led identity header shared by the primary music detail routes. */
export function MusicDetailHero({
    eyebrow,
    title,
    artwork,
    artworkShape,
    metadata,
    description,
    titleAfter,
    actions,
    backgroundImage,
    ambientColors,
    className,
}: MusicDetailHeroProps) {
    return (
        <header
            data-music-detail="hero"
            className={cn(
                "relative isolate overflow-hidden border-b border-white/[0.07]",
                className,
            )}
        >
            <div
                className="pointer-events-none absolute inset-0"
                style={ambientStyle(ambientColors)}
                aria-hidden="true"
            />
            {backgroundImage && (
                <div
                    className="pointer-events-none absolute inset-0 overflow-hidden opacity-35"
                    aria-hidden="true"
                >
                    <Image
                        src={backgroundImage}
                        alt=""
                        fill
                        sizes="100vw"
                        className="scale-110 object-cover blur-3xl saturate-125"
                        priority
                        unoptimized
                    />
                </div>
            )}
            <div
                className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgb(7_8_11/0.24),transparent_55%,rgb(7_8_11/0.3)),linear-gradient(0deg,var(--music-canvas),transparent_65%)]"
                aria-hidden="true"
            />

            <div className="relative mx-auto max-w-[1800px] px-4 pb-6 pt-9 sm:px-6 sm:pb-8 sm:pt-12 lg:px-8 lg:pb-10 lg:pt-16">
                <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:items-end sm:gap-8 sm:text-left">
                    <div
                        className={cn(
                            "relative h-44 w-44 shrink-0 overflow-hidden bg-surface-highlight shadow-[0_26px_70px_rgb(0_0_0/0.42)] ring-1 ring-white/15 sm:h-52 sm:w-52 lg:h-56 lg:w-56",
                            artworkShape === "round"
                                ? "rounded-full"
                                : "rounded-[22px]",
                        )}
                    >
                        {artwork}
                    </div>

                    <div className="min-w-0 w-full flex-1 pb-1">
                        <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-white/75">
                            {eyebrow}
                        </p>
                        <div className="flex min-w-0 items-start justify-center gap-3 sm:justify-start">
                            <h1 className="min-w-0 max-w-full text-[clamp(2.25rem,8vw,5.5rem)] font-black leading-[0.92] tracking-[-0.055em] text-white [overflow-wrap:anywhere]">
                                {title}
                            </h1>
                            {titleAfter}
                        </div>
                        {metadata && (
                            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm font-medium text-white/75 sm:justify-start">
                                {metadata}
                            </div>
                        )}
                        {description && (
                            <div className="mt-3 max-w-2xl text-sm leading-6 text-white/65">
                                {description}
                            </div>
                        )}
                    </div>
                </div>

                {actions && (
                    <div
                        className="mt-6 sm:mt-7"
                        role="group"
                        aria-label={`${eyebrow}: действия`}
                    >
                        {actions}
                    </div>
                )}
            </div>
        </header>
    );
}
