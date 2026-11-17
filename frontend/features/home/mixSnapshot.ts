/** Additive composition metadata; absent on older compatible servers. */
export interface MixSnapshot {
    generatedAt?: string;
    checkedAt?: string;
    compositionKey?: string;
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
    const checkedAt = value.checkedAt;
    const checkedTime =
        typeof checkedAt === "string" &&
        checkedAt.length <= 64 &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
            checkedAt,
        )
            ? Date.parse(checkedAt)
            : NaN;
    const wallTime =
        typeof checkedAt === "string"
            ? Date.parse(`${checkedAt.slice(0, 19)}Z`)
            : NaN;
    if (
        (checkedAt !== undefined &&
            (!Number.isFinite(checkedTime) ||
                !Number.isFinite(wallTime) ||
                new Date(wallTime).toISOString().slice(0, 19) !==
                    String(checkedAt).slice(0, 19))) ||
        (value.compositionKey !== undefined &&
            (typeof value.compositionKey !== "string" ||
                !/^daypart-v1:[a-f0-9]{64}$/.test(value.compositionKey)))
    )
        return {};
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
    if (!Number.isFinite(time)) {
        return typeof checkedAt === "string" && Number.isFinite(checkedTime)
            ? {
                  dateTime: checkedAt,
                  dateLabel: `Проверено в ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(checkedTime)}`,
                  detail,
              }
            : { detail };
    }
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
