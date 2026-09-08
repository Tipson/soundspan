import { BRAND_SLUG } from "@/lib/brand";
import type {
    PersonalizedHomeMood,
    PersonalizedHomeLanguage,
} from "@/features/home/types";

export type WaveSelectionMode = "for-you" | "new" | "familiar";
export type WaveSelectionMood = PersonalizedHomeMood | null;

export interface WaveSelection {
    mode: WaveSelectionMode;
    mood: WaveSelectionMood;
    language: PersonalizedHomeLanguage;
}

const WAVE_MODE_IDS = new Set<WaveSelectionMode>([
    "for-you",
    "new",
    "familiar",
]);
const WAVE_MOOD_IDS = new Set<PersonalizedHomeMood>([
    "calm",
    "energetic",
    "focus",
    "workout",
    "favorites",
    "forgotten",
]);
const WAVE_SELECTION_KEY_PREFIX = `${BRAND_SLUG}_wave_selection_v1`;
const DEFAULT_WAVE_SELECTION: WaveSelection = {
    mode: "for-you",
    mood: null,
    language: "any",
};

export function waveSelectionStorageKey(ownerId: string): string {
    return `${WAVE_SELECTION_KEY_PREFIX}:${encodeURIComponent(ownerId)}`;
}

export function readPersistedWaveSelection(
    ownerId: string | null,
): WaveSelection {
    if (!ownerId || typeof window === "undefined") {
        return DEFAULT_WAVE_SELECTION;
    }
    try {
        const raw = window.localStorage.getItem(
            waveSelectionStorageKey(ownerId),
        );
        if (!raw) return DEFAULT_WAVE_SELECTION;
        const parsed = JSON.parse(raw) as {
            mode?: unknown;
            mood?: unknown;
            language?: unknown;
        };
        return {
            // Language selection is retired until catalog coverage is sufficient.
            // Keep mode/mood, but never restore a hidden restrictive filter.
            language: "any",
            mode:
                typeof parsed.mode === "string" &&
                WAVE_MODE_IDS.has(parsed.mode as WaveSelectionMode)
                    ? (parsed.mode as WaveSelectionMode)
                    : DEFAULT_WAVE_SELECTION.mode,
            mood:
                typeof parsed.mood === "string" &&
                WAVE_MOOD_IDS.has(parsed.mood as PersonalizedHomeMood)
                    ? (parsed.mood as PersonalizedHomeMood)
                    : DEFAULT_WAVE_SELECTION.mood,
        };
    } catch {
        return DEFAULT_WAVE_SELECTION;
    }
}

export function persistWaveSelection(
    ownerId: string | null,
    mode: WaveSelectionMode,
    mood: WaveSelectionMood,
    _language: PersonalizedHomeLanguage = "any",
): void {
    if (!ownerId || typeof window === "undefined") return;
    try {
        window.localStorage.setItem(
            waveSelectionStorageKey(ownerId),
            JSON.stringify({ mode, mood, language: "any" }),
        );
    } catch {
        // The applied in-memory selection remains usable in restricted storage.
    }
}

export function readWaveSelection(ownerId: string | null): WaveSelection {
    const persisted = readPersistedWaveSelection(ownerId);
    if (typeof window === "undefined") return persisted;
    const params = new URLSearchParams(window.location.search);
    const requestedMode = params.get("mode");
    const requestedMood = params.get("mood");
    const hasModeOverride = params.has("mode");
    const hasMoodOverride = params.has("mood");
    return {
        language: "any",
        mode:
            requestedMode &&
            WAVE_MODE_IDS.has(requestedMode as WaveSelectionMode)
                ? (requestedMode as WaveSelectionMode)
                : persisted.mode,
        mood:
            hasMoodOverride &&
            requestedMood &&
            WAVE_MOOD_IDS.has(requestedMood as PersonalizedHomeMood)
                ? (requestedMood as PersonalizedHomeMood)
                : hasModeOverride || hasMoodOverride
                  ? null
                  : persisted.mood,
    };
}

export function replaceWaveSelection(
    mode: WaveSelectionMode,
    mood: WaveSelectionMood,
    _language: PersonalizedHomeLanguage = "any",
): void {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("mode", mode);
    url.searchParams.delete("language");
    if (mood) url.searchParams.set("mood", mood);
    else url.searchParams.delete("mood");
    window.history.replaceState(window.history.state, "", url);
}
