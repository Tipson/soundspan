"use client";

import { Info } from "lucide-react";
import { useState } from "react";

interface InfoTooltipProps {
    text: string;
}

/**
 * Renders the InfoTooltip component.
 */
export function InfoTooltip({ text }: InfoTooltipProps) {
    const [showTooltip, setShowTooltip] = useState(false);

    return (
        <span className="relative inline-flex">
            <button
                type="button"
                onMouseEnter={() => setShowTooltip(true)}
                onMouseLeave={() => setShowTooltip(false)}
                onClick={() => setShowTooltip((current) => !current)}
                aria-expanded={showTooltip}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-content-muted transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                aria-label="Подробнее"
                title="Подробнее"
            >
                <Info className="h-4 w-4" />
            </button>
            {showTooltip && (
                <span
                    role="tooltip"
                    className="absolute left-0 top-full z-30 mt-1 w-72 rounded-xl border border-line bg-surface-overlay p-3 text-xs leading-5 text-content-secondary shadow-2xl"
                >
                    {text}
                </span>
            )}
        </span>
    );
}
