"use client";

import { ru } from "@/lib/i18n/ru";

/** Props for the full-page OIDC navigation button. */
export interface SsoButtonProps {
    providerName: string;
    onClick: () => void;
}

/** Starts a full-page sign-in navigation to the configured OIDC provider. */
export function SsoButton({ providerName, onClick }: SsoButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-full border border-line-muted bg-white/[0.03] px-5 py-3 text-sm font-bold text-content transition-colors hover:border-white/25 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
        >
            {ru.auth.signInWith} {providerName}
        </button>
    );
}
