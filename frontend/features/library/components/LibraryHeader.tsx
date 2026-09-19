import { Music2 } from "lucide-react";
import { ru } from "@/lib/i18n/ru";

/**
 * Renders the LibraryHeader component.
 */
export function LibraryHeader() {
    return (
        <header
            data-library-surface="hero"
            className="relative overflow-hidden border-b border-white/[0.06]"
        >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_18%_-20%,rgb(124_156_255/0.24),transparent_46%),linear-gradient(180deg,var(--music-stage),transparent)]" />
            <div className="pointer-events-none absolute -right-16 top-10 h-44 w-44 rounded-full bg-brand/10 blur-3xl sm:h-64 sm:w-64" />
            <div className="relative mx-auto flex max-w-[1800px] items-start gap-3 px-4 py-6 sm:items-end sm:gap-6 sm:px-6 sm:pb-10 sm:pt-16 lg:px-8 lg:pb-12">
                <span className="mb-1 grid h-10 w-10 shrink-0 place-items-center rounded-[18px] border border-white/10 bg-white/[0.06] text-brand-light shadow-[0_18px_48px_rgb(0_0_0/0.22)] backdrop-blur-xl sm:h-16 sm:w-16">
                    <Music2
                        className="h-5 w-5 sm:h-8 sm:w-8"
                        aria-hidden="true"
                    />
                </span>
                <div className="min-w-0">
                    <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-brand-light">
                        {ru.library.eyebrow}
                    </p>
                    <h1 className="text-3xl font-black leading-tight tracking-[-0.055em] text-content sm:text-[clamp(2.5rem,7vw,5.25rem)] sm:leading-[0.94]">
                        {ru.library.title}
                    </h1>
                    <p className="mt-3 max-w-2xl text-sm leading-6 text-content-muted sm:text-base">
                        {ru.library.subtitle}
                    </p>
                </div>
            </div>
        </header>
    );
}
