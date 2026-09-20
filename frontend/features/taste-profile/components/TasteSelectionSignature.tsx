import { useId } from "react";
import { CachedImage } from "@/components/ui/CachedImage";

interface TasteSelectionSignatureProps {
    artists: readonly string[];
    artwork: Readonly<Record<string, string>>;
    count: number;
}

/** Decorative feedback, not a required selection target or a quality score. */
export function TasteSelectionSignature({
    artists,
    artwork,
    count,
}: TasteSelectionSignatureProps) {
    const gradientId = useId();
    const energy = 1 - Math.exp(-count / 5);
    const recentArtists = artists.slice(-4);

    return (
        <div className="hidden lg:block" aria-hidden="true">
            <div
                data-testid="taste-selection-signature"
                className="relative mx-auto mb-5 aspect-square w-full max-w-56"
            >
                <div
                    className="absolute inset-3 rounded-full bg-brand/15 blur-2xl transition-opacity duration-700 motion-reduce:transition-none"
                    style={{ opacity: 0.35 + energy * 0.65 }}
                />
                <svg
                    viewBox="0 0 224 224"
                    className="relative h-full w-full overflow-visible"
                    fill="none"
                >
                    <defs>
                        <linearGradient
                            id={gradientId}
                            x1="24"
                            y1="30"
                            x2="200"
                            y2="196"
                            gradientUnits="userSpaceOnUse"
                        >
                            <stop stopColor="#e5d6ff" />
                            <stop offset="0.5" stopColor="#b477ff" />
                            <stop offset="1" stopColor="#6854bd" />
                        </linearGradient>
                    </defs>
                    <circle
                        cx="112"
                        cy="112"
                        r="102"
                        stroke="currentColor"
                        className="text-white/5"
                    />
                    <circle
                        cx="112"
                        cy="112"
                        r="86"
                        stroke="currentColor"
                        className="text-brand/15"
                    />
                    <circle
                        cx="112"
                        cy="112"
                        r="68"
                        stroke="currentColor"
                        className="text-brand/10"
                    />
                    <circle
                        cx="112"
                        cy="112"
                        r="102"
                        stroke={`url(#${gradientId})`}
                        strokeWidth="2"
                        strokeLinecap="round"
                        pathLength="100"
                        strokeDasharray="100"
                        strokeDashoffset={82 - energy * 70}
                        transform="rotate(-90 112 112)"
                        className="transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
                    />
                    {Array.from({ length: 27 }, (_, index) => {
                        const envelope = Math.sin((index / 26) * Math.PI);
                        const ripple = Math.sin(index * 1.8 + count * 0.65);
                        const height =
                            7 +
                            envelope *
                                (24 + energy * 62) *
                                (0.5 + Math.abs(ripple) * 0.5);
                        return (
                            <rect
                                key={index}
                                x={32 + index * 6}
                                y="62"
                                width="3"
                                height="100"
                                rx="1.5"
                                fill={`url(#${gradientId})`}
                                style={{
                                    transformOrigin: `${33.5 + index * 6}px 112px`,
                                    transform: `scaleY(${height / 100})`,
                                    opacity: 0.5 + envelope * 0.5,
                                }}
                                className="transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none"
                            />
                        );
                    })}
                </svg>
            </div>
            <div
                data-testid="taste-selection-preview"
                className="mb-5 flex h-11 items-center justify-center -space-x-2"
            >
                {recentArtists.length > 0 ? (
                    recentArtists.map((artist) => (
                        <span
                            key={artist}
                            data-artist={artist}
                            title={artist}
                            className="relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full border-[3px] border-surface-raised bg-brand/20 text-xs font-semibold text-brand-light"
                        >
                            <CachedImage
                                src={artwork[artist]}
                                alt=""
                                fill
                                sizes="44px"
                                className="object-cover"
                                fallback={
                                    <span>
                                        {artist
                                            .split(/\s+/)
                                            .slice(0, 2)
                                            .map((word) => word[0])
                                            .join("")}
                                    </span>
                                }
                            />
                        </span>
                    ))
                ) : (
                    <span className="text-xs font-medium tracking-[0.18em] text-content-muted">
                        ВАШЕ ЗВУЧАНИЕ
                    </span>
                )}
                {artists.length > 4 && (
                    <span className="relative grid h-11 min-w-11 place-items-center rounded-full border-[3px] border-surface-raised bg-surface-highlight px-1 text-xs font-semibold text-content-secondary">
                        +{artists.length - 4}
                    </span>
                )}
            </div>
        </div>
    );
}
