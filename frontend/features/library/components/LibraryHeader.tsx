import { Music2 } from "lucide-react";

/**
 * Renders the LibraryHeader component.
 */
export function LibraryHeader() {
    return (
        <header className="relative overflow-hidden">
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-brand/12 via-ai/[0.035] to-transparent" />
            <div className="relative mx-auto flex max-w-[1800px] items-end gap-4 px-4 pb-6 pt-10 sm:gap-5 sm:px-6 sm:pb-8 sm:pt-14 lg:px-8">
                <span className="mb-1 grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-brand/20 bg-brand/15 text-brand-light shadow-lg shadow-brand/5 sm:h-14 sm:w-14">
                    <Music2
                        className="h-6 w-6 sm:h-7 sm:w-7"
                        aria-hidden="true"
                    />
                </span>
                <div className="min-w-0">
                    <p className="mb-1 text-xs font-bold uppercase tracking-[0.18em] text-brand-light">
                        Your collection
                    </p>
                    <h1 className="text-4xl font-black tracking-[-0.045em] text-content sm:text-6xl">
                        Your Library
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-content-muted sm:text-base">
                        Likes and saved music follow your account. Offline
                        copies stay on the phone or computer where you
                        downloaded them.
                    </p>
                </div>
            </div>
        </header>
    );
}
