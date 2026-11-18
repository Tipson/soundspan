/** Process configuration for limited keyed creation and independent recovery. */
export interface PlayCreationRollout {
    newCreationsEnabled: boolean;
    replaySupported: boolean;
    newCreationUserIds: readonly string[];
}

/**
 * Maps operator controls to an explicit, bounded owner cohort. Unknown modes
 * remain off; malformed cohorts disable new producers while retaining replay.
 * No environment access occurs here: config.ts owns that boundary.
 */
export function parsePlayCreationRollout(
    mode: string | undefined,
    cohort: string | undefined,
): PlayCreationRollout {
    const normalized = mode?.trim().toLowerCase();
    const replaySupported = normalized === "replay" || normalized === "cohort";
    const inactive: PlayCreationRollout = {
        newCreationsEnabled: false,
        replaySupported,
        newCreationUserIds: Object.freeze([]),
    };
    if (
        normalized !== "cohort" ||
        !cohort ||
        Buffer.byteLength(cohort, "utf8") > 40 * 1024
    ) {
        return inactive;
    }
    const entries = cohort.split(",").map((entry) => entry.trim());
    if (
        entries.length > 256 ||
        entries.some((entry) => !/^[A-Za-z0-9_-]{1,128}$/.test(entry))
    ) {
        return inactive;
    }
    return {
        newCreationsEnabled: true,
        replaySupported: true,
        newCreationUserIds: Object.freeze([...new Set(entries)]),
    };
}
