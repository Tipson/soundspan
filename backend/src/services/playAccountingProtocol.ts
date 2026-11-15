import { createHash } from "node:crypto";
import { z } from "zod";
import { musicSourcePlayRecordingSchema } from "./musicSourcePlaySnapshot";

/** Validated creation fields shared by the legacy and versioned adapters. */
export const playPayloadSchema = z
    .object({
        trackId: z.string().optional(),
        tidalTrackId: z.number().int().positive().optional(),
        youtubeVideoId: z.string().trim().min(1).optional(),
        musicSourceRecording: musicSourcePlayRecordingSchema.optional(),
        title: z.string().trim().min(1).optional(),
        artist: z.string().trim().min(1).optional(),
        album: z.string().trim().min(1).optional(),
        duration: z.number().int().nonnegative().optional(),
        thumbnailUrl: z.string().trim().min(1).optional(),
        playContext: z
            .enum([
                "wave",
                "home",
                "search",
                "playlist",
                "album",
                "artist",
                "library",
            ])
            .optional(),
        waveMode: z.enum(["for-you", "new", "familiar"]).optional(),
        recommendationGenerationId: z
            .string()
            .trim()
            .min(1)
            .max(128)
            .optional(),
        recommendationSessionId: z.string().trim().min(1).max(128).optional(),
    })
    .superRefine((data, context) => {
        const identifiers = [
            data.trackId,
            data.tidalTrackId,
            data.youtubeVideoId,
            data.musicSourceRecording,
        ].filter(Boolean);
        if (
            identifiers.length !== 1 ||
            (data.musicSourceRecording && data.trackId !== undefined)
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["trackId"],
                message: "Exactly one track identifier required",
            });
        }
        if (
            (data.tidalTrackId || data.youtubeVideoId) &&
            (!data.title ||
                !data.artist ||
                !data.album ||
                data.duration === undefined)
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["title"],
                message:
                    "Remote play logging requires title, artist, album, and duration",
            });
        }
    });

/** An accepted, bounded wire snapshot; resolved server metadata is not hashed. */
export type PlayCreationPayload = z.infer<typeof playPayloadSchema>;

/** Absolute engagement totals retain the existing monotonic outcome ordering. */
export const playEngagementSchema = z
    .object({
        listenedSeconds: z.number().finite().min(0).max(86_400),
        completionRatio: z.number().finite().min(0).max(1),
        outcome: z.enum(["meaningful", "completed", "skipped", "failed"]),
    })
    .strict();
/** Validated absolute engagement, rather than an increment or retry counter. */
export type PlayEngagement = z.infer<typeof playEngagementSchema>;

const outcomes = ["failed", "skipped", "meaningful", "completed"] as const;

/** Rejects lowering either progress component or weakening an equal-progress outcome. */
export function monotonicEngagementFilter(engagement: PlayEngagement) {
    return {
        AND: [
            {
                OR: [
                    { completionRatio: null },
                    { completionRatio: { lte: engagement.completionRatio } },
                ],
            },
            {
                OR: [
                    { listenedSeconds: null },
                    { listenedSeconds: { lte: engagement.listenedSeconds } },
                ],
            },
            {
                OR: [
                    { completionRatio: null },
                    { completionRatio: { lt: engagement.completionRatio } },
                    { listenedSeconds: null },
                    { listenedSeconds: { lt: engagement.listenedSeconds } },
                    {
                        AND: [
                            { completionRatio: engagement.completionRatio },
                            { listenedSeconds: engagement.listenedSeconds },
                            {
                                OR: [
                                    { outcome: null },
                                    {
                                        outcome: {
                                            in: outcomes.slice(
                                                0,
                                                outcomes.indexOf(
                                                    engagement.outcome,
                                                ) + 1,
                                            ),
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

/** Closed application failures; their messages never include a payload or credential. */
export class PlayAccountingError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
    ) {
        super(code);
        this.name = "PlayAccountingError";
    }
}

/** Closed transient DB failures permit retry of the same key, never a new key. */
export function classifyPlayAccountingFailure(
    error: unknown,
): PlayAccountingError | null {
    if (error instanceof PlayAccountingError) return error;
    if (typeof error !== "object" || error === null) return null;
    const record = error as Record<string, unknown>;
    const meta =
        typeof record.meta === "object" && record.meta !== null
            ? (record.meta as Record<string, unknown>)
            : {};
    const adapter =
        typeof meta.driverAdapterError === "object" &&
        meta.driverAdapterError !== null
            ? (meta.driverAdapterError as Record<string, unknown>)
            : {};
    const cause =
        typeof adapter.cause === "object" && adapter.cause !== null
            ? (adapter.cause as Record<string, unknown>)
            : {};
    const transient = new Set([
        "P1001",
        "P1002",
        "P1008",
        "P1017",
        "P2024",
        "P2028",
        "P2034",
        "P2037",
        "40001",
        "40P01",
        "55P03",
        "57014",
        "ECONNREFUSED",
        "ECONNRESET",
    ]);
    return [record.code, meta.code, cause.code].some(
        (code) => typeof code === "string" && transient.has(code),
    )
        ? new PlayAccountingError(503, "play_accounting_unavailable")
        : null;
}

/** Key time is immutable and independent of a later request's body or clock. */
export interface ParsedPlayCreationKey {
    epoch: number;
    issuedAtMs: number;
    expiresAtMs: number;
}

const windowMs = 24 * 60 * 60 * 1000;
const futureSkewMs = 300_000;

/** Parses only canonical p1 ASCII keys whose date arithmetic stays representable. */
export function parsePlayCreationKey(value: unknown): ParsedPlayCreationKey {
    const invalid = () =>
        new PlayAccountingError(400, "play_creation_invalid_key");
    if (typeof value !== "string" || value.length > 64) throw invalid();
    const match =
        /^p1\.([0-9a-z]{1,6})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{32})$/.exec(
            value,
        );
    if (!match) throw invalid();
    const epoch = Number.parseInt(match[1], 36);
    const issuedAtMs = Number.parseInt(match[2], 36);
    if (
        !Number.isSafeInteger(epoch) ||
        epoch < 0 ||
        epoch > 2_147_483_647 ||
        epoch.toString(36) !== match[1] ||
        !Number.isSafeInteger(issuedAtMs) ||
        issuedAtMs < 0 ||
        issuedAtMs > 8_640_000_000_000_000 - windowMs ||
        issuedAtMs.toString(36) !== match[2]
    ) {
        throw invalid();
    }
    return { epoch, issuedAtMs, expiresAtMs: issuedAtMs + windowMs };
}

/** Revalidated under the owner lock immediately before replay or commit. */
export function assertPlayKeyCurrent(
    key: ParsedPlayCreationKey,
    owner: { epoch: number; prunedThrough: Date | null },
    nowMs: number,
): void {
    if (key.epoch !== owner.epoch)
        throw new PlayAccountingError(410, "play_history_epoch_changed");
    if (owner.prunedThrough && key.issuedAtMs <= owner.prunedThrough.getTime())
        throw new PlayAccountingError(410, "play_key_pruned");
    if (nowMs >= key.expiresAtMs)
        throw new PlayAccountingError(410, "play_key_expired");
    if (key.issuedAtMs > nowMs + futureSkewMs)
        throw new PlayAccountingError(400, "play_creation_invalid_key");
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, entry]) => entry !== undefined)
                .sort(([one], [two]) => (one < two ? -1 : one > two ? 1 : 0))
                .map(([name, entry]) => [name, canonical(entry)]),
        );
    }
    return value;
}

/** Hashes the canonical accepted v1 DTO, omitting unaccepted metadata and trace IDs. */
export function hashPlayCreationRequest(value: unknown): string {
    return createHash("sha256")
        .update(
            JSON.stringify(
                canonical({
                    version: 1,
                    payload: playPayloadSchema.parse(value),
                }),
            ),
        )
        .digest("hex");
}
