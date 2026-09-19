/** Allowlisted manual incident evidence for the private administrator notification. */
export function playbackReportDetails(metadata: unknown): [string, string][] {
    if (!metadata || typeof metadata !== "object" || !("fields" in metadata))
        return [];
    const fields = metadata.fields;
    if (!fields || typeof fields !== "object") return [];
    const values = fields as Record<string, unknown>;
    const rows: [string, string][] = [];
    const identifier = (value: unknown): value is string =>
        typeof value === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(value);
    if (identifier(values.reportTrackId))
        rows.push(["Трек", values.reportTrackId]);
    if (
        typeof values.currentTimeSec === "number" &&
        Number.isFinite(values.currentTimeSec) &&
        values.currentTimeSec >= 0
    )
        rows.push(["Позиция", `${Math.round(values.currentTimeSec)} с`]);
    if (typeof values.localSource === "boolean")
        rows.push([
            "Источник",
            values.localSource ? "На устройстве" : "Онлайн",
        ]);
    if (typeof values.online === "boolean")
        rows.push(["Интернет", values.online ? "Есть" : "Нет"]);
    if (identifier(values.frontendBuildId))
        rows.push(["Сборка", values.frontendBuildId]);
    if (identifier(values.playbackRunId))
        rows.push(["Сессия плеера", values.playbackRunId]);
    return rows;
}
