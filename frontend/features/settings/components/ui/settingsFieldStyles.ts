/**
 * Settings focus-ring tokens provide a WCAG 1.4.11 compliant (at least 3:1)
 * focus indicator against the focused input background.
 */
export const SETTINGS_FOCUS_RING_TOKEN = "brand-hover";

/** Tailwind classes for the shared settings-field focus indicator. */
export const SETTINGS_FIELD_FOCUS_RING =
    "focus:outline-none focus:ring-2 focus:ring-brand-hover";

const settingsButtonBase =
    "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-[10px] px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

/** Primary action style for settings forms and their dialogs. */
export const SETTINGS_PRIMARY_BUTTON = `${settingsButtonBase} bg-brand text-black hover:bg-brand-hover`;

/** Secondary action style for settings forms and their dialogs. */
export const SETTINGS_SECONDARY_BUTTON = `${settingsButtonBase} border border-line text-content-secondary hover:bg-surface-hover hover:text-content`;

/** Destructive action style for existing settings confirmations. */
export const SETTINGS_DANGER_BUTTON = `${settingsButtonBase} bg-red-500 text-white hover:bg-red-600`;
