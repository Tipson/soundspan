import type { TasteProfileSelection } from "./types";

export const MAX_TASTE_LABEL_LENGTH = 80;

type TasteKind = "genres" | "artists";

export type TasteSelectionValidationCode = "valid" | "invalid-label";

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

/** Mirror the backend's label validation with actionable Russian copy. */
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
    return {
        selection: { ...selection, [kind]: [...selection[kind], label] },
        error: null,
    };
}

/** Toggle a suggestion without imposing a selection count limit. */
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
