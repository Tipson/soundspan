import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/utils/cn";

type ArtworkShape = "round" | "square" | "portrait";

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
        background: `linear-gradient(155deg, color-mix(in srgb, ${top} 22%, var(--music-stage)) 0%, color-mix(in srgb, ${middle} 36%, var(--music-stage)) 44%, ${bottom} 100%)`,
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
                "relative z-10 isolate overflow-visible border-b border-white/[0.07]",
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
                    className="pointer-events-none absolute inset-0 overflow-hidden opacity-20"
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

            <div className="relative mx-auto max-w-[1800px] px-4 pb-6 pt-6 sm:px-6 sm:pb-8 sm:pt-10 lg:px-8 lg:pb-10 lg:pt-12">
                <div className="flex flex-col items-center gap-5 text-center sm:flex-row sm:items-end sm:gap-7 sm:text-left">
                    <div
                        className={cn(
                            "relative shrink-0 overflow-hidden bg-surface-highlight shadow-[0_16px_42px_rgb(0_0_0/0.3)]",
                            artworkShape === "portrait"
                                ? "h-48 w-36 sm:h-60 sm:w-44 lg:h-64 lg:w-48"
                                : "h-40 w-40 sm:h-48 sm:w-48 lg:h-56 lg:w-56",
                            artworkShape === "round"
                                ? "rounded-full"
                                : "rounded-[14px]",
                        )}
                    >
                        {artwork}
                    </div>

                    <div className="min-w-0 w-full flex-1 pb-1">
                        <p className="mb-2 text-sm font-medium text-content-secondary">
                            {eyebrow}
                        </p>
                        <div className="flex min-w-0 items-start justify-center gap-3 sm:justify-start">
                            <h1 className="min-w-0 max-w-full text-balance text-3xl sm:text-5xl lg:text-6xl font-bold leading-[1.04] tracking-[-0.035em] text-content [overflow-wrap:anywhere]">
                                {title}
                            </h1>
                            {titleAfter}
                        </div>
                        {metadata && (
                            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm font-medium text-content-secondary sm:justify-start">
                                {metadata}
                            </div>
                        )}
                        {description && (
                            <div className="mt-3 max-w-2xl text-sm leading-6 text-content-secondary">
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
