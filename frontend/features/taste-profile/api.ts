import { api } from "@/lib/api";
import type {
    TasteProfileSelection,
    TasteProfileState,
    TasteProfileWriteMode,
    TasteProfileWriteRequest,
} from "./types";

const TASTE_PROFILE_ENDPOINT = "/taste-profile";

/** Load the current authenticated account's onboarding state. */
export function getTasteProfile(
    signal?: AbortSignal,
): Promise<TasteProfileState> {
    return api.request<TasteProfileState>(TASTE_PROFILE_ENDPOINT, {
        method: "GET",
        signal,
    });
}

function writeTasteProfile(
    mode: TasteProfileWriteMode,
    body: TasteProfileWriteRequest,
): Promise<TasteProfileState> {
    if (mode === "create") {
        return api.post<TasteProfileState>(TASTE_PROFILE_ENDPOINT, body);
    }
    return api.request<TasteProfileState>(TASTE_PROFILE_ENDPOINT, {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

/** Complete first-run taste onboarding without creating synthetic likes. */
export function createTasteProfile(
    selection: TasteProfileSelection,
): Promise<TasteProfileState> {
    return writeTasteProfile("create", selection);
}

/** Replace the current account's saved taste selections. */
export function replaceTasteProfile(
    selection: TasteProfileSelection,
): Promise<TasteProfileState> {
    return writeTasteProfile("replace", selection);
}

/** Explicitly finish onboarding without saving any taste signals. */
export function skipTasteProfile(
    mode: TasteProfileWriteMode,
): Promise<TasteProfileState> {
    return writeTasteProfile(mode, { skip: true });
}

/** Turn transport failures into actionable, non-technical Russian UI copy. */
export function tasteProfileErrorMessage(error: unknown): string {
    if (error instanceof Error && "status" in error) {
        const status = (error as Error & { status?: number }).status;
        if (status === 400) {
            return "Проверьте выбор: нужно от 3 до 16 жанров и артистов.";
        }
        if (status === 503) {
            return "Источник музыки не смог подобрать стартовые треки. Попробуйте другие варианты или повторите позже.";
        }
    }
    return "Не удалось сохранить музыкальные предпочтения. Проверьте подключение и попробуйте ещё раз.";
}
