/** Durable coverage for one analysis stage; remaining includes failed work. */
export interface OnlineAnalysisStage {
    completed: number;
    remaining: number;
    failed: number;
    completedLast24h: number;
}

/** Administrator-only aggregate, shared across accounts and provider mappings. */
export interface OnlineAnalysisSnapshot {
    generatedAt: string;
    enabled: boolean;
    total: number;
    activeAssets: number;
    activeSpace: { id: string; family: string } | null;
    audio: OnlineAnalysisStage;
    embeddings: OnlineAnalysisStage | null;
    budget: {
        dailyLimit: number;
        concurrency: number;
        checkedToday: number | null;
        resetsAt: string;
    };
}

/** Reject malformed telemetry rather than presenting unknown values as zero. */
export function parseOnlineAnalysisSnapshot(
    value: unknown,
): OnlineAnalysisSnapshot {
    const invalid = () => {
        throw new Error("Invalid online analysis snapshot");
    };
    const record = (item: unknown): Record<string, unknown> => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            return invalid();
        return item as Record<string, unknown>;
    };
    const integer = (item: unknown): number =>
        typeof item === "number" && Number.isSafeInteger(item) && item >= 0
            ? item
            : invalid();
    const date = (item: unknown): string =>
        typeof item === "string" && Number.isFinite(Date.parse(item))
            ? item
            : invalid();
    const data = record(value);
    const total = integer(data.total);
    const stage = (item: unknown): OnlineAnalysisStage => {
        const row = record(item);
        const result = {
            completed: integer(row.completed),
            remaining: integer(row.remaining),
            failed: integer(row.failed),
            completedLast24h: integer(row.completedLast24h),
        };
        if (
            result.completed + result.remaining !== total ||
            result.failed > result.remaining ||
            result.completedLast24h > result.completed
        )
            return invalid();
        return result;
    };
    const budget = record(data.budget);
    const space = data.activeSpace === null ? null : record(data.activeSpace);
    if (
        space &&
        (typeof space.id !== "string" || typeof space.family !== "string")
    )
        return invalid();
    if (typeof data.enabled !== "boolean") return invalid();
    return {
        generatedAt: date(data.generatedAt),
        enabled: data.enabled,
        total,
        activeAssets: integer(data.activeAssets),
        activeSpace: space
            ? { id: space.id as string, family: space.family as string }
            : null,
        audio: stage(data.audio),
        embeddings: data.embeddings === null ? null : stage(data.embeddings),
        budget: {
            dailyLimit: integer(budget.dailyLimit),
            concurrency: integer(budget.concurrency),
            checkedToday:
                budget.checkedToday === null
                    ? null
                    : integer(budget.checkedToday),
            resetsAt: date(budget.resetsAt),
        },
    };
}
