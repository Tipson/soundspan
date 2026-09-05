import type { Prisma } from "@prisma/client";
import { performance } from "node:perf_hooks";

import { prisma } from "../../utils/db";
import type { RecommendationCandidate } from "./types";

export interface ResolvedCanonicalRecording {
    id: string;
    canonicalKey: string;
}

interface CanonicalAliasRow extends ResolvedCanonicalRecording {
    mergedIntoId: string | null;
    identitySource: string | null;
}

const CANONICAL_MERGE_MAX_DEPTH = 16;
const CANONICAL_TRANSACTION_ATTEMPTS = 8;
const CANONICAL_TRANSACTION_RETRY_BASE_DELAY_MS = 5;
const CANONICAL_TRANSACTION_RETRY_MAX_DELAY_MS = 80;
const CANONICAL_TRANSACTION_TOTAL_BUDGET_MS = 5_000;
const CANONICAL_TRANSACTION_MAX_WAIT_MS = 2_000;
const CANONICAL_TRANSACTION_TIMEOUT_MS = 2_000;
const CANONICAL_TRANSACTION_MIN_BUDGET_MS = 2;
const canonicalAliasSelect = {
    id: true,
    canonicalKey: true,
    mergedIntoId: true,
    identitySource: true,
} as const;

function nestedErrorRecords(error: unknown): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    const pending: Array<{ candidate: unknown; depth: number }> = [
        { candidate: error, depth: 0 },
    ];
    const seen = new Set<unknown>();
    while (pending.length > 0) {
        const { candidate, depth } = pending.shift()!;
        if (
            depth >= 4 ||
            typeof candidate !== "object" ||
            candidate === null ||
            seen.has(candidate)
        ) {
            continue;
        }
        seen.add(candidate);
        const record = candidate as Record<string, unknown>;
        records.push(record);
        const meta =
            typeof record.meta === "object" && record.meta !== null
                ? (record.meta as Record<string, unknown>)
                : null;
        pending.push(
            { candidate: record.cause, depth: depth + 1 },
            { candidate: meta, depth: depth + 1 },
            { candidate: meta?.driverAdapterError, depth: depth + 1 },
        );
    }
    return records;
}

function isRetryableCanonicalTransactionAbort(error: unknown): boolean {
    const records = nestedErrorRecords(error);
    if (
        records.some(
            (record) =>
                [record.code, record.originalCode].some((code) =>
                    ["P2002", "P2034", "40001", "40P01"].includes(
                        String(code ?? ""),
                    ),
                ) || record.kind === "TransactionWriteConflict",
        )
    ) {
        return true;
    }
    return records.some((record) => {
        const message =
            typeof record.message === "string"
                ? record.message.toLowerCase()
                : "";
        return (
            message.includes("could not serialize") ||
            message.includes("deadlock") ||
            message.includes("unable to start a transaction in the given time")
        );
    });
}

async function pauseBeforeCanonicalTransactionRetry(
    attempt: number,
    remainingBudgetMs: number,
): Promise<void> {
    const delay = Math.min(
        CANONICAL_TRANSACTION_RETRY_MAX_DELAY_MS,
        CANONICAL_TRANSACTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    );
    const jitter = Math.floor(Math.random() * delay);
    await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delay + jitter, remainingBudgetMs)),
    );
}

function allocateCanonicalTransactionBudget(remainingBudgetMs: number): {
    maxWait: number;
    timeout: number;
} {
    const transactionBudgetMs = Math.min(
        CANONICAL_TRANSACTION_MAX_WAIT_MS + CANONICAL_TRANSACTION_TIMEOUT_MS,
        Math.floor(remainingBudgetMs),
    );
    const maxWait = Math.max(
        1,
        Math.min(
            CANONICAL_TRANSACTION_MAX_WAIT_MS,
            Math.floor(transactionBudgetMs / 2),
        ),
    );
    return {
        maxWait,
        timeout: Math.max(
            1,
            Math.min(
                CANONICAL_TRANSACTION_TIMEOUT_MS,
                transactionBudgetMs - maxWait,
            ),
        ),
    };
}

/** Run canonical identity mutations at one serializable snapshot with bounded retry. */
export async function runCanonicalIdentityTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    const deadline = performance.now() + CANONICAL_TRANSACTION_TOTAL_BUDGET_MS;
    let lastRetryableError: unknown;
    for (
        let attempt = 1;
        attempt <= CANONICAL_TRANSACTION_ATTEMPTS;
        attempt += 1
    ) {
        const remainingBudgetMs = deadline - performance.now();
        if (remainingBudgetMs < CANONICAL_TRANSACTION_MIN_BUDGET_MS) {
            if (lastRetryableError !== undefined) throw lastRetryableError;
            throw new Error(
                "Canonical identity transaction time budget expired",
            );
        }
        const transactionBudget =
            allocateCanonicalTransactionBudget(remainingBudgetMs);
        try {
            return await prisma.$transaction(operation, {
                isolationLevel: "Serializable",
                maxWait: transactionBudget.maxWait,
                timeout: transactionBudget.timeout,
            });
        } catch (error) {
            const remainingRetryBudgetMs = deadline - performance.now();
            if (
                attempt === CANONICAL_TRANSACTION_ATTEMPTS ||
                !isRetryableCanonicalTransactionAbort(error) ||
                remainingRetryBudgetMs < CANONICAL_TRANSACTION_MIN_BUDGET_MS
            ) {
                throw error;
            }
            lastRetryableError = error;
            await pauseBeforeCanonicalTransactionRetry(
                attempt,
                remainingRetryBudgetMs,
            );
        }
    }
    throw new Error("Canonical identity transaction retry bound was exceeded");
}

/** Follow a preserved merge alias to its one live canonical survivor. */
export async function resolveCanonicalSurvivor(
    database: Pick<Prisma.TransactionClient, "canonicalRecording">,
    initial: CanonicalAliasRow,
): Promise<ResolvedCanonicalRecording> {
    const visited = new Set<string>();
    let current = initial;
    for (let depth = 0; depth < CANONICAL_MERGE_MAX_DEPTH; depth += 1) {
        if (visited.has(current.id)) {
            throw new Error("Canonical merge alias cycle detected");
        }
        visited.add(current.id);
        if (!current.mergedIntoId) {
            if (current.identitySource === "identity-merged") {
                throw new Error(
                    "Canonical merge alias has no surviving target",
                );
            }
            return { id: current.id, canonicalKey: current.canonicalKey };
        }
        const target = await database.canonicalRecording.findUnique({
            where: { id: current.mergedIntoId },
            select: canonicalAliasSelect,
        });
        if (!target) {
            throw new Error("Canonical merge alias target is missing");
        }
        current = target;
    }
    throw new Error("Canonical merge alias chain is too deep");
}

/** Minimal provider identity used outside the recommendation pipeline. */
export interface ProviderTrackIdentity {
    source: RecommendationCandidate["source"];
    providerTrackId: string | number;
    title: string;
    artist: string;
    album?: string;
    duration?: number;
    recordingMbid?: string | null;
    isrc?: string | null;
    fingerprint?: string | null;
}

/** Converts a provider/import identity into the internal candidate shape. */
export function providerTrackIdentityToCandidate(
    input: ProviderTrackIdentity,
): RecommendationCandidate {
    const providerTrackId = String(input.providerTrackId);
    const tidalTrackId =
        input.source === "tidal" ? Number(providerTrackId) : null;
    const youtubeVideoId = input.source === "youtube" ? providerTrackId : null;
    return {
        id:
            input.source === "library"
                ? providerTrackId
                : `${input.source}:${providerTrackId}`,
        canonicalKey: "",
        recordingMbid: input.recordingMbid,
        isrc: input.isrc,
        fingerprint: input.fingerprint,
        title: input.title,
        duration: Math.max(0, Math.round(input.duration ?? 0)),
        artist: { id: null, name: input.artist },
        album: {
            id: null,
            title: input.album ?? "",
            coverArt: null,
        },
        source: input.source,
        provider: { tidalTrackId, youtubeVideoId },
        streamSource: input.source,
        youtubeVideoId: youtubeVideoId ?? undefined,
        tidalTrackId: tidalTrackId ?? undefined,
        candidateSources: ["provider-identity"],
        providerPrior: 1,
    };
}

interface CanonicalIdentityDependencies {
    findProviderMapping: (
        provider: RecommendationCandidate["source"],
        providerTrackId: string,
    ) => Promise<ResolvedCanonicalRecording | null>;
    findCanonical: (
        candidate: RecommendationCandidate,
        canonicalKey: string,
    ) => Promise<ResolvedCanonicalRecording | null>;
    upsertCanonical: (
        candidate: RecommendationCandidate,
        canonicalKey: string,
    ) => Promise<ResolvedCanonicalRecording>;
    attachProviderMapping: (
        candidate: RecommendationCandidate,
        canonicalRecordingId: string,
    ) => Promise<void>;
}

function normalizedText(value: string): string {
    return value
        .normalize("NFKC")
        .replace(/[‘’`′ʼ]/g, "'")
        .toLocaleLowerCase("en-US")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

/** Durable-identity ladder shared by provider dedupe and analysis reuse. */
export function buildCanonicalRecordingKey(
    candidate: Pick<
        RecommendationCandidate,
        | "recordingMbid"
        | "isrc"
        | "fingerprint"
        | "artist"
        | "title"
        | "duration"
    >,
): string {
    const mbid = candidate.recordingMbid?.trim().toLocaleLowerCase("en-US");
    if (mbid) return `mbid:${mbid}`;
    const isrc = candidate.isrc?.replace(/[^a-z0-9]/giu, "").toUpperCase();
    if (isrc) return `isrc:${isrc}`;
    const fingerprint = candidate.fingerprint?.trim().toLocaleLowerCase();
    if (fingerprint) return `fingerprint:${fingerprint}`;
    const durationBucket = Math.max(0, Math.round(candidate.duration / 3) * 3);
    return `meta:${normalizedText(candidate.artist.name)}:${normalizedText(
        candidate.title,
    )}:${durationBucket}`;
}

function providerTrackId(candidate: RecommendationCandidate): string | null {
    if (candidate.source === "youtube") {
        return (
            candidate.provider.youtubeVideoId ??
            candidate.youtubeVideoId ??
            null
        );
    }
    if (candidate.source === "tidal") {
        return (
            candidate.provider.tidalTrackId?.toString() ??
            candidate.tidalTrackId?.toString() ??
            null
        );
    }
    return candidate.id || null;
}

export class CanonicalIdentityResolver {
    constructor(private readonly dependencies: CanonicalIdentityDependencies) {}

    async resolve(
        candidate: RecommendationCandidate,
    ): Promise<ResolvedCanonicalRecording> {
        const providerId = providerTrackId(candidate);
        if (providerId) {
            const mapped = await this.dependencies.findProviderMapping(
                candidate.source,
                providerId,
            );
            if (mapped) return mapped;
        }
        const canonicalKey = buildCanonicalRecordingKey(candidate);
        let canonical = await this.dependencies.findCanonical(
            candidate,
            canonicalKey,
        );
        if (!canonical) {
            try {
                canonical = await this.dependencies.upsertCanonical(
                    candidate,
                    canonicalKey,
                );
            } catch (error) {
                canonical = await this.dependencies.findCanonical(
                    candidate,
                    canonicalKey,
                );
                if (!canonical) throw error;
            }
        }
        if (providerId) {
            await this.dependencies.attachProviderMapping(
                candidate,
                canonical.id,
            );
        }
        return canonical;
    }

    /**
     * Resolves imported/provider metadata without making callers construct the
     * much wider recommendation candidate shape.
     */
    async resolveProviderTrack(
        input: ProviderTrackIdentity,
    ): Promise<ResolvedCanonicalRecording> {
        return this.resolve(providerTrackIdentityToCandidate(input));
    }
}

async function findProviderMapping(
    provider: RecommendationCandidate["source"],
    id: string,
): Promise<ResolvedCanonicalRecording | null> {
    const providerWhere =
        provider === "youtube"
            ? { trackYtMusic: { is: { videoId: id } } }
            : provider === "tidal"
              ? { trackTidal: { is: { tidalId: Number(id) } } }
              : { track: { is: { id } } };
    const mapping = await prisma.trackMapping.findFirst({
        where: {
            ...providerWhere,
            stale: false,
            canonicalRecordingId: { not: null },
        },
        select: {
            canonicalRecording: { select: canonicalAliasSelect },
        },
    });
    if (!mapping?.canonicalRecording) return null;
    return resolveCanonicalSurvivor(prisma, mapping.canonicalRecording);
}

async function findCanonical(
    candidate: RecommendationCandidate,
    canonicalKey: string,
): Promise<ResolvedCanonicalRecording | null> {
    const durableMatches = [
        candidate.recordingMbid
            ? { recordingMbid: candidate.recordingMbid.trim() }
            : null,
        candidate.isrc
            ? { isrc: candidate.isrc.replace(/[^a-z0-9]/giu, "").toUpperCase() }
            : null,
        candidate.fingerprint
            ? { fingerprint: candidate.fingerprint.trim() }
            : null,
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const durable =
        durableMatches.length > 0
            ? await prisma.canonicalRecording.findFirst({
                  where: { OR: durableMatches },
                  select: canonicalAliasSelect,
              })
            : null;
    const match =
        durable ??
        (await prisma.canonicalRecording.findFirst({
            where: { canonicalKey },
            select: canonicalAliasSelect,
        }));
    if (!match) return null;
    return resolveCanonicalSurvivor(prisma, match);
}

async function upsertCanonical(
    candidate: RecommendationCandidate,
    canonicalKey: string,
): Promise<ResolvedCanonicalRecording> {
    const canonical = await prisma.canonicalRecording.upsert({
        where: { canonicalKey },
        create: {
            canonicalKey,
            recordingMbid: candidate.recordingMbid?.trim() || null,
            isrc:
                candidate.isrc?.replace(/[^a-z0-9]/giu, "").toUpperCase() ||
                null,
            fingerprint: candidate.fingerprint?.trim() || null,
            title: candidate.title.trim(),
            artist: candidate.artist.name.trim(),
            duration: Math.max(0, Math.round(candidate.duration)),
        },
        update: {
            recordingMbid: candidate.recordingMbid?.trim() || undefined,
            isrc:
                candidate.isrc?.replace(/[^a-z0-9]/giu, "").toUpperCase() ||
                undefined,
            fingerprint: candidate.fingerprint?.trim() || undefined,
        },
        select: canonicalAliasSelect,
    });
    return resolveCanonicalSurvivor(prisma, canonical);
}

async function attachProviderMapping(
    candidate: RecommendationCandidate,
    canonicalRecordingId: string,
): Promise<void> {
    await runCanonicalIdentityTransaction(async (transaction) => {
        const canonical = await transaction.canonicalRecording.findUnique({
            where: { id: canonicalRecordingId },
            select: canonicalAliasSelect,
        });
        if (!canonical) throw new Error("Canonical recording is missing");
        const survivor = await resolveCanonicalSurvivor(transaction, canonical);
        await attachProviderMappingInTransaction(
            transaction,
            candidate,
            survivor.id,
        );
    });
}

async function attachProviderMappingInTransaction(
    transaction: Prisma.TransactionClient,
    candidate: RecommendationCandidate,
    canonicalRecordingId: string,
): Promise<void> {
    if (candidate.source === "youtube") {
        const videoId = providerTrackId(candidate);
        if (!videoId) return;
        const providerTrack = await transaction.trackYtMusic.upsert({
            where: { videoId },
            create: {
                videoId,
                title: candidate.title,
                artist: candidate.artist.name,
                album: candidate.album.title,
                duration: Math.max(0, Math.round(candidate.duration)),
                thumbnailUrl: candidate.album.coverArt,
            },
            update: {
                title: candidate.title,
                artist: candidate.artist.name,
                album: candidate.album.title,
                duration: Math.max(0, Math.round(candidate.duration)),
                thumbnailUrl: candidate.album.coverArt,
            },
            select: { id: true },
        });
        const mapping = await transaction.trackMapping.findFirst({
            where: { trackYtMusicId: providerTrack.id, stale: false },
            select: { id: true },
        });
        if (mapping) {
            await transaction.trackMapping.update({
                where: { id: mapping.id },
                data: { canonicalRecordingId },
            });
        } else {
            await transaction.trackMapping.create({
                data: {
                    trackYtMusicId: providerTrack.id,
                    canonicalRecordingId,
                    confidence: 0.72,
                    source: "recommendation",
                },
            });
        }
        return;
    }
    if (candidate.source === "tidal") {
        const rawId = providerTrackId(candidate);
        const tidalId = rawId ? Number(rawId) : Number.NaN;
        if (!Number.isSafeInteger(tidalId)) return;
        const providerTrack = await transaction.trackTidal.upsert({
            where: { tidalId },
            create: {
                tidalId,
                title: candidate.title,
                artist: candidate.artist.name,
                album: candidate.album.title,
                duration: Math.max(0, Math.round(candidate.duration)),
                isrc: candidate.isrc || null,
            },
            update: {
                title: candidate.title,
                artist: candidate.artist.name,
                album: candidate.album.title,
                duration: Math.max(0, Math.round(candidate.duration)),
                isrc: candidate.isrc || undefined,
            },
            select: { id: true },
        });
        const mapping = await transaction.trackMapping.findFirst({
            where: { trackTidalId: providerTrack.id, stale: false },
            select: { id: true },
        });
        if (mapping) {
            await transaction.trackMapping.update({
                where: { id: mapping.id },
                data: { canonicalRecordingId },
            });
        } else {
            await transaction.trackMapping.create({
                data: {
                    trackTidalId: providerTrack.id,
                    canonicalRecordingId,
                    confidence: candidate.isrc ? 0.95 : 0.72,
                    source: "recommendation",
                },
            });
        }
    }
}

export const canonicalIdentityResolver = new CanonicalIdentityResolver({
    findProviderMapping,
    findCanonical,
    upsertCanonical,
    attachProviderMapping,
});
