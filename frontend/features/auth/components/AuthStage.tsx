import Image from "next/image";
import type { ReactNode } from "react";
import { BRAND_NAME, BRAND_NAME_TRADEMARK } from "@/lib/brand";

interface AuthStageProps {
    children: ReactNode;
    backdrop?: ReactNode;
    aside?: ReactNode;
    width?: "compact" | "wide";
    footer?: boolean;
}

interface AuthPanelProps {
    children: ReactNode;
    className?: string;
}

/** Shared Spectral Stage frame for authentication and first-run flows. */
export function AuthStage({
    children,
    backdrop,
    aside,
    width = "compact",
    footer = true,
}: AuthStageProps) {
    const contentWidth = width === "wide" ? "max-w-5xl" : "max-w-md";

    return (
        <main
            data-auth-stage="spectral"
            className="relative min-h-dvh overflow-hidden bg-surface text-content"
        >
            <div
                className="pointer-events-none absolute inset-0"
                aria-hidden="true"
            >
                {backdrop}
                <div className="absolute inset-0 bg-gradient-to-b from-surface/20 via-surface/72 to-surface" />
            </div>

            <div className="relative z-10 flex min-h-dvh items-center px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
                <div
                    className={`mx-auto w-full ${aside ? "max-w-6xl" : contentWidth}`}
                >
                    <div
                        className={
                            aside
                                ? "grid items-end gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]"
                                : undefined
                        }
                    >
                        {aside && (
                            <aside className="hidden min-w-0 pb-8 lg:block">
                                {aside}
                            </aside>
                        )}
                        <div className="min-w-0">
                            <AuthBrand />
                            {children}
                            {footer && (
                                <p className="mt-6 text-center text-xs leading-5 text-content-muted sm:text-sm">
                                    Музыка, которая становится вашей.
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}

/** Calm elevated surface used inside {@link AuthStage}. */
export function AuthPanel({ children, className = "" }: AuthPanelProps) {
    return (
        <section
            data-auth-panel="true"
            className={`rounded-[var(--music-radius-card)] bg-surface-raised/95 p-5 shadow-xl shadow-black/20 sm:p-7 ${className}`}
        >
            {children}
        </section>
    );
}

function AuthBrand() {
    return (
        <div className="mb-6 flex items-center justify-center gap-3 sm:mb-7">
            <span className="relative grid h-12 w-12 place-items-center">
                <Image
                    src="/assets/images/soundspan.webp"
                    alt={BRAND_NAME}
                    width={42}
                    height={42}
                    sizes="42px"
                    className="relative"
                    priority
                />
            </span>
            <span className="brand-wordmark text-3xl font-black text-content sm:text-4xl">
                {BRAND_NAME_TRADEMARK}
            </span>
        </div>
    );
}
