import type { DeviceOfflineDownloadRecord } from "./types";

/** Lifetime of an active foreground download lease. */
export const DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS = 30_000;

/** Maximum tolerated forward clock skew for a persisted lease. */
export const DEVICE_OFFLINE_LEASE_MAX_FUTURE_MS = 5 * 60_000;

const DEVICE_OFFLINE_LEGACY_FOREGROUND_GRACE_MS = 30_000;

/** State of a persisted foreground lease relative to the current clock. */
export type ForegroundLeaseDisposition = "live" | "clamp" | "expired";

/** Classifies whether a persisted foreground lease is current or stale. */
export function foregroundLeaseDisposition(
    record: DeviceOfflineDownloadRecord,
    now: number,
): ForegroundLeaseDisposition {
    const leaseId = record.foregroundLeaseId;
    const expiresAt =
        typeof record.foregroundLeaseExpiresAt === "number"
            ? record.foregroundLeaseExpiresAt
            : Number.NaN;
    if (
        typeof leaseId === "string" &&
        leaseId.length > 0 &&
        Number.isFinite(expiresAt)
    ) {
        const remaining = expiresAt - now;
        if (remaining > DEVICE_OFFLINE_LEASE_MAX_FUTURE_MS) return "clamp";
        return remaining > 0 ? "live" : "expired";
    }

    const age = now - Number(record.updatedAt);
    if (!Number.isFinite(age)) return "expired";
    if (age < -DEVICE_OFFLINE_LEASE_MAX_FUTURE_MS) return "clamp";
    return age <= DEVICE_OFFLINE_LEGACY_FOREGROUND_GRACE_MS
        ? "live"
        : "expired";
}

/** Rewrites an implausibly future-dated lease against the current clock. */
export function clampForegroundLeaseClockSkew(
    record: DeviceOfflineDownloadRecord,
    now: number,
): DeviceOfflineDownloadRecord {
    return {
        ...record,
        ...(record.foregroundLeaseId
            ? {
                  foregroundLeaseExpiresAt:
                      now + DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
              }
            : {}),
        updatedAt: now,
    };
}

/** Marks an expired foreground download as interrupted. */
export function interruptExpiredForegroundRecord(
    record: DeviceOfflineDownloadRecord,
    now: number,
): DeviceOfflineDownloadRecord {
    return {
        ...record,
        status: "interrupted",
        backgroundFetchId:
            record.transferMode === "background"
                ? null
                : record.backgroundFetchId,
        foregroundLeaseId: null,
        foregroundLeaseExpiresAt: null,
        errorCode: "interrupted",
        errorMessage:
            "Загрузка была прервана. При продолжении загрузка этого трека начнётся заново.",
        updatedAt: now,
    };
}
