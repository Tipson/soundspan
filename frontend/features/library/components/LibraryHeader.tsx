import { Music2 } from "lucide-react";
import { ru } from "@/lib/i18n/ru";

/**
 * Renders the LibraryHeader component.
 */
export function LibraryHeader() {
    return (
        <header data-library-surface="hero" className="border-b border-line">
            <div className="mx-auto flex max-w-[1800px] items-start gap-3 px-4 py-6 sm:items-center sm:gap-4 sm:px-6 sm:py-8 lg:px-8">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-surface-active text-content-secondary sm:h-14 sm:w-14">
                    <Music2
                        className="h-5 w-5 sm:h-8 sm:w-8"
                        aria-hidden="true"
                    />
                </span>
                <div className="min-w-0">
                    <h1 className="text-3xl font-bold leading-tight tracking-[-0.03em] text-content sm:text-4xl">
                        {ru.library.title}
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-content-secondary">
                        {ru.library.subtitle}
                    </p>
                </div>
            </div>
        </header>
    );
}
