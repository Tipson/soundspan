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
            className="inline-flex min-h-12 w-full items-center justify-center rounded-[var(--music-radius-control)] border border-line-muted bg-surface-elevated px-5 py-3 text-base font-semibold text-content transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
        >
            {ru.auth.signInWith} {providerName}
        </button>
    );
}
