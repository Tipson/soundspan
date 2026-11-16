import type { PlayEngagementResponse } from "./api/plays";
import { z } from "zod";
import { readPlayCreateKey } from "./playCreateJournal";

/** Exact immutable acknowledgement from the versioned Play creation endpoint. */
export type PlayCreateWireAck = Readonly<{
    id: string;
    playCreation: Readonly<{
        version: 1;
        clientPlaybackId: string;
        disposition: "created" | "replayed";
        replayExpiresAt: string;
    }>;
}>;

const creationSchema = z
    .object({
        id: z
            .string()
            .min(1)
            .max(128)
            .refine((id) => id.trim() === id),
        playCreation: z
            .object({
                version: z.literal(1),
                clientPlaybackId: z.string(),
                disposition: z.enum(["created", "replayed"]),
                replayExpiresAt: z.string(),
            })
            .strict(),
    })
    .strict();
const engagementSchema = z
    .object({ success: z.literal(true), stale: z.boolean().optional() })
    .strict();
const maxDelayMs = 86_400_000;

/** Snapshot own enumerable data properties without evaluating untrusted getters. */
function dataRecord(raw: unknown): Record<string, unknown> | null {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return null;
    try {
        const prototype = Object.getPrototypeOf(raw);
        if (prototype !== null && prototype !== Object.prototype) return null;
        const row: Record<string, unknown> = Object.create(null);
        for (const name of Reflect.ownKeys(raw)) {
            // Zod deliberately drops this key instead of reporting it as unknown.
            if (typeof name !== "string" || name === "__proto__") return null;
            const descriptor = Object.getOwnPropertyDescriptor(raw, name);
            if (
                !descriptor ||
                !("value" in descriptor) ||
                !descriptor.enumerable
            )
                return null;
            row[name] = descriptor.value;
        }
        return row;
    } catch {
        return null;
    }
}

/** Read an exact creation receipt whose key and canonical ISO expiry match the submitted key. */
export function readPlayCreateAck(
    raw: unknown,
    expectedKey: string,
): PlayCreateWireAck | null {
    const key = readPlayCreateKey(expectedKey),
        row = dataRecord(raw);
    if (!key || !row) return null;
    const creation = dataRecord(row.playCreation);
    if (!creation) return null;
    const parsed = creationSchema.safeParse({ ...row, playCreation: creation });
    if (
        !parsed.success ||
        parsed.data.playCreation.clientPlaybackId !== key.value ||
        parsed.data.playCreation.replayExpiresAt !==
            new Date(key.expiresAtMs).toISOString()
    )
        return null;
    return Object.freeze({
        id: parsed.data.id,
        playCreation: Object.freeze(parsed.data.playCreation),
    });
}

/** Read the exact successful engagement response. */
export function readPlayEngagementAck(
    raw: unknown,
): Readonly<PlayEngagementResponse> | null {
    const row = dataRecord(raw);
    if (!row || ("stale" in row && typeof row.stale !== "boolean")) return null;
    const parsed = engagementSchema.safeParse(row);
    return parsed.success ? Object.freeze(parsed.data) : null;
}

/** Bound work before accepting optional HTTP space/tab; no general string/date coercion. */
function headerValue(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length > 128) return null;
    return raw.replace(/^[ \t]+|[ \t]+$/g, "");
}

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];

/** Parse RFC 9110 HTTP-date grammar and calendar fields in UTC without platform date parsing. */
function httpDate(value: string, referenceMs?: number): number | null {
    let match =
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) ([A-Z][a-z]{2}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
            value,
        );
    let weekday: string,
        day: number,
        month: number,
        year: number,
        hour: number,
        minute: number,
        second: number;
    let obsoleteYear = false;
    if (match && match[0] === value) {
        [, weekday] = match;
        day = Number(match[2]);
        month = months.indexOf(match[3]);
        year = Number(match[4]);
        hour = Number(match[5]);
        minute = Number(match[6]);
        second = Number(match[7]);
    } else {
        match =
            /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ([0-9]{2}| [0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(
                value,
            );
        if (match && match[0] === value) {
            [, weekday] = match;
            day = Number(match[3]);
            month = months.indexOf(match[2]);
            year = Number(match[7]);
            hour = Number(match[4]);
            minute = Number(match[5]);
            second = Number(match[6]);
        } else {
            match =
                /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-([A-Z][a-z]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
                    value,
                );
            // A two-digit server Date cannot provide an independent century anchor.
            if (!match || match[0] !== value || referenceMs === undefined)
                return null;
            weekday = match[1].slice(0, 3);
            day = Number(match[2]);
            month = months.indexOf(match[3]);
            year =
                Math.floor(
                    (new Date(referenceMs).getUTCFullYear() + 50) / 100,
                ) *
                    100 +
                Number(match[4]);
            hour = Number(match[5]);
            minute = Number(match[6]);
            second = Number(match[7]);
            obsoleteYear = true;
        }
    }
    if (
        month < 0 ||
        day < 1 ||
        day > 31 ||
        hour > 23 ||
        minute > 59 ||
        second > 60
    )
        return null;
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    date.setUTCHours(hour, minute, Math.min(second, 59), 0);
    if (obsoleteYear && referenceMs !== undefined) {
        const future = new Date(referenceMs);
        future.setUTCFullYear(future.getUTCFullYear() + 50);
        if (date.getTime() > future.getTime()) {
            year -= 100;
            date.setUTCFullYear(year);
        }
    }
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month ||
        date.getUTCDate() !== day ||
        days[date.getUTCDay()] !== weekday
    )
        return null;
    return date.getTime() + (second === 60 ? 1000 : 0);
}

/** Read delta-seconds or an HTTP-date relative only to a valid four-digit server Date; clamp to 24h. */
export function readPlayRetryAfterMs(
    rawRetryAfter: unknown,
    rawServerDate: unknown,
): number | null {
    const retry = headerValue(rawRetryAfter);
    if (!retry) return null;
    if (/^[0-9]+$/.test(retry) && !retry.includes("\n"))
        return Math.min(Number(retry), maxDelayMs / 1000) * 1000;
    const server = headerValue(rawServerDate);
    if (!server) return null;
    const serverMs = httpDate(server);
    if (serverMs === null) return null;
    const retryMs = httpDate(retry, serverMs);
    return retryMs === null
        ? null
        : Math.min(maxDelayMs, Math.max(0, retryMs - serverMs));
}
