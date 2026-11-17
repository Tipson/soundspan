/** Additive composition metadata; absent on older compatible servers. */
export interface MixSnapshot {
    generatedAt?: string;
    compositionDay?: string;
    weekStart?: string;
    weekEnd?: string;
    refreshAfter: string;
    requestedCount: number;
    snapshotCount: number;
    availableCount: number;
    reasons: Array<"provider_degraded" | "pool_limited" | "feedback_filtered">;
}

/** Describe the server composition without treating a refetch as regeneration. */
export function mixSnapshotDetails(raw: unknown): {
    dateTime?: string;
    dateLabel?: string;
    detail?: string;
} {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const value = raw as Record<string, unknown>;
    const time =
        typeof value.generatedAt === "string" && value.generatedAt.length <= 64
            ? Date.parse(value.generatedAt)
            : NaN;
    const reasons = Array.isArray(value.reasons) ? value.reasons : [];
    const detail = reasons.includes("provider_degraded")
        ? "Часть музыки временно недоступна"
        : reasons.includes("feedback_filtered")
          ? "С учётом ваших оценок"
          : reasons.includes("pool_limited")
            ? "Пока меньше подходящих треков"
            : undefined;
    if (!Number.isFinite(time)) return { detail };
    return {
        dateTime: value.generatedAt as string,
        dateLabel: `Состав от ${new Intl.DateTimeFormat("ru-RU", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "UTC",
        }).format(time)}`,
        detail,
    };
}
