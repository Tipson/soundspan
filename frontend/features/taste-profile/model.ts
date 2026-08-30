import type { TasteProfileSelection } from "./types";

export const MIN_TASTE_SIGNALS = 3;
export const MAX_TASTE_SIGNALS = 16;
export const MAX_TASTE_LABELS_PER_KIND = 10;
export const MAX_TASTE_LABEL_LENGTH = 80;

type TasteKind = "genres" | "artists";

export type TasteSelectionValidationCode =
    | "valid"
    | "too-few"
    | "too-many-total"
    | "too-many-genres"
    | "too-many-artists"
    | "invalid-label";

export interface TasteSelectionValidation {
    code: TasteSelectionValidationCode;
    message: string | null;
    count: number;
}

function labelKey(value: string): string {
    return value.toLocaleLowerCase("ru-RU");
}

/** Match a saved label to a suggestion without depending on display casing. */
export function isTasteLabelSelected(
    values: readonly string[],
    label: string,
): boolean {
    const key = labelKey(label.trim());
    return values.some((value) => labelKey(value) === key);
}

/** Trim labels and remove case-insensitive duplicates while preserving order. */
export function normalizeTasteLabels(values: readonly string[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const label = value.trim();
        if (!label) continue;
        const key = labelKey(label);
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(label);
    }
    return normalized;
}

/** Normalize both editable groups before validation or transport. */
export function normalizeTasteProfileSelection(
    selection: TasteProfileSelection,
): TasteProfileSelection {
    return {
        genres: normalizeTasteLabels(selection.genres),
        artists: normalizeTasteLabels(selection.artists),
    };
}

function invalidTasteLabel(value: string): boolean {
    return (
        value.length > MAX_TASTE_LABEL_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(value)
    );
}

/** Mirror the backend's bounded selection contract with actionable Russian copy. */
export function validateTasteProfileSelection(
    value: TasteProfileSelection,
): TasteSelectionValidation {
    const selection = normalizeTasteProfileSelection(value);
    const count = selection.genres.length + selection.artists.length;
    if ([...selection.genres, ...selection.artists].some(invalidTasteLabel)) {
        return {
            code: "invalid-label",
            message:
                "Одно из названий слишком длинное или содержит недопустимые символы.",
            count,
        };
    }
    if (selection.genres.length > MAX_TASTE_LABELS_PER_KIND) {
        return {
            code: "too-many-genres",
            message: "Можно выбрать не больше 10 жанров.",
            count,
        };
    }
    if (selection.artists.length > MAX_TASTE_LABELS_PER_KIND) {
        return {
            code: "too-many-artists",
            message: "Можно выбрать не больше 10 артистов.",
            count,
        };
    }
    if (count > MAX_TASTE_SIGNALS) {
        return {
            code: "too-many-total",
            message:
                "Оставьте не больше 16 вариантов — так стартовая подборка будет точнее.",
            count,
        };
    }
    if (count < MIN_TASTE_SIGNALS) {
        const missing = MIN_TASTE_SIGNALS - count;
        return {
            code: "too-few",
            message: `Выберите ещё ${missing}, чтобы настроить рекомендации.`,
            count,
        };
    }
    return { code: "valid", message: null, count };
}

/** Add one label without mutating the caller's selection. */
export function addTasteLabel(
    value: TasteProfileSelection,
    kind: TasteKind,
    rawLabel: string,
): { selection: TasteProfileSelection; error: string | null } {
    const selection = normalizeTasteProfileSelection(value);
    const label = rawLabel.trim();
    if (!label) {
        return { selection, error: "Введите название артиста." };
    }
    if (/[\u0000-\u001f\u007f]/u.test(label)) {
        return {
            selection,
            error: "Название содержит недопустимые символы.",
        };
    }
    if (label.length > MAX_TASTE_LABEL_LENGTH) {
        return {
            selection,
            error: "Название должно быть короче 80 символов.",
        };
    }
    if (isTasteLabelSelected(selection[kind], label)) {
        return { selection, error: null };
    }
    if (selection[kind].length >= MAX_TASTE_LABELS_PER_KIND) {
        return {
            selection,
            error: "В каждой группе можно выбрать не больше 10 вариантов.",
        };
    }
    if (
        selection.genres.length + selection.artists.length >=
        MAX_TASTE_SIGNALS
    ) {
        return {
            selection,
            error: "Всего можно выбрать не больше 16 вариантов.",
        };
    }
    return {
        selection: { ...selection, [kind]: [...selection[kind], label] },
        error: null,
    };
}

/** Toggle a suggestion while keeping both selection groups bounded. */
export function toggleTasteLabel(
    value: TasteProfileSelection,
    kind: TasteKind,
    label: string,
): { selection: TasteProfileSelection; error: string | null } {
    const selection = normalizeTasteProfileSelection(value);
    const existingIndex = selection[kind].findIndex(
        (item) => labelKey(item) === labelKey(label.trim()),
    );
    if (existingIndex < 0) return addTasteLabel(selection, kind, label);
    return {
        selection: {
            ...selection,
            [kind]: selection[kind].filter(
                (_item, index) => index !== existingIndex,
            ),
        },
        error: null,
    };
}
