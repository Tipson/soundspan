/** Early-skip evidence shared by taste updates and recommendation evaluation. */
export function isEarlyRecommendationSkip(row: {
    outcome: string | null;
    completionRatio: number | null;
    listenedSeconds: number | null;
}): boolean {
    if (row.outcome !== "skipped") return false;
    return (
        (row.completionRatio !== null &&
            row.completionRatio >= 0 &&
            row.completionRatio <= 0.2) ||
        (row.listenedSeconds !== null &&
            row.listenedSeconds >= 0 &&
            row.listenedSeconds < 30)
    );
}
