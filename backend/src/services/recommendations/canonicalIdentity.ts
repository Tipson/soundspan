import { Prisma } from "@prisma/client";
import { performance } from "node:perf_hooks";

import { prisma } from "../../utils/db";
import { isValidMbid } from "../../utils/musicIds";
import type { RecommendationCandidate } from "./types";
import {
    hasNativeRecommendationIdentity,
    readNativeRecommendationRecording,
} from "./nativeCandidates";
import { readVerifiedMusicSourceRecording } from "../musicSources/verifiedMetadata";
import { isProviderMappingEligible } from "../providerMappingEligibility";

export interface ResolvedCanonicalRecording {
    id: string;
    canonicalKey: string;
    /** Server-proven exact edge; absent for metadata-only canonical deduplication. */
    verifiedCanonicalKey?: string;
}

interface CanonicalAliasRow extends ResolvedCanonicalRecording {
    mergedIntoId: string | null;
    identitySource: string | null;
    recordingMbid?: string | null;
    isrc?: string | null;
    title?: string;
    artist?: string;
    duration?: number | null;
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
    recordingMbid: true,
    isrc: true,
    title: true,
    artist: true,
    duration: true,
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

/** Follow a preserved merge alias, optionally checking the caller's fence between hops. */
export async function resolveCanonicalSurvivor(
    database: Pick<Prisma.TransactionClient, "canonicalRecording">,
    initial: CanonicalAliasRow,
    check?: () => void,
): Promise<ResolvedCanonicalRecording> {
    const survivor = await readCanonicalSurvivor(database, initial, check);
    return { id: survivor.id, canonicalKey: survivor.canonicalKey };
}

async function readCanonicalSurvivor(
    database: Pick<Prisma.TransactionClient, "canonicalRecording">,
    initial: CanonicalAliasRow,
    check?: () => void,
): Promise<CanonicalAliasRow> {
    const visited = new Set<string>();
    let current = initial;
    for (let depth = 0; depth < CANONICAL_MERGE_MAX_DEPTH; depth += 1) {
        check?.();
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
            return current;
        }
        const target = await database.canonicalRecording.findUnique({
            where: { id: current.mergedIntoId },
            select: canonicalAliasSelect,
        });
        check?.();
        if (!target) {
            throw new Error("Canonical merge alias target is missing");
        }
        current = target;
    }
    throw new Error("Canonical merge alias chain is too deep");
}

/** Minimal provider identity used outside the recommendation pipeline. */
export interface ProviderTrackIdentity {
    source: "youtube" | "tidal" | "library";
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
    if (hasNativeRecommendationIdentity(candidate))
        return readNativeRecommendationRecording(candidate)?.id ?? null;
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
        // Native recommendation metadata is not the server byte-probe attestation.
        // Only the verified playback writer may create this fourth mapping.
        if (hasNativeRecommendationIdentity(candidate))
            throw new Error(
                "Native identity requires a confirmed exact mapping",
            );
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
        select: canonicalMappingSelect,
    });
    if (!mapping?.canonicalRecording) return null;
    const survivor = await readCanonicalSurvivor(
        prisma,
        mapping.canonicalRecording,
    );
    return mappedIdentity(
        mapping,
        { source: provider, providerTrackId: id },
        survivor,
    );
}

/** Exact provider reference; metadata never supplies an alias in this read path. */
export interface CanonicalProviderReference {
    source: RecommendationCandidate["source"];
    providerTrackId: string;
}

const canonicalMappingSelect = {
    source: true,
    confidence: true,
    trackYtMusic: {
        select: { videoId: true, title: true, artist: true, duration: true },
    },
    trackTidal: {
        select: {
            tidalId: true,
            title: true,
            artist: true,
            duration: true,
            isrc: true,
        },
    },
    track: {
        select: {
            id: true,
            title: true,
            duration: true,
            isrc: true,
            recordingMbid: true,
            album: { select: { artist: { select: { name: true } } } },
        },
    },
    trackMusicSource: {
        select: {
            provider: true,
            providerTrackId: true,
            verifiedMetadata: true,
            metadataObservedAt: true,
            metadataConnectionVersion: true,
        },
    },
    canonicalRecording: { select: canonicalAliasSelect },
} as const;

type MappingEvidence = Prisma.TrackMappingGetPayload<{
    select: typeof canonicalMappingSelect;
}>;

function mappingReferences(row: MappingEvidence): CanonicalProviderReference[] {
    const native = readVerifiedMusicSourceRecording(row.trackMusicSource);
    const references: Array<CanonicalProviderReference | null> = [
        native ? { source: native.provider, providerTrackId: native.id } : null,
        row.trackYtMusic
            ? { source: "youtube", providerTrackId: row.trackYtMusic.videoId }
            : null,
        row.trackTidal
            ? {
                  source: "tidal",
                  providerTrackId: String(row.trackTidal.tidalId),
              }
            : null,
        row.track ? { source: "library", providerTrackId: row.track.id } : null,
    ];
    return references.filter(
        (ref): ref is CanonicalProviderReference => ref !== null,
    );
}

function feedbackKeys(ref: CanonicalProviderReference): string[] {
    if (ref.source === "youtube")
        return /^[A-Za-z0-9_-]{1,64}$/.test(ref.providerTrackId)
            ? [`yt:${ref.providerTrackId}`, ref.providerTrackId]
            : [];
    if (ref.source === "library")
        return ref.providerTrackId &&
            !/^(?:yt|tidal|vk|yandex):/.test(ref.providerTrackId)
            ? [ref.providerTrackId]
            : [];
    if (
        ref.source === "tidal" &&
        (!Number.isSafeInteger(Number(ref.providerTrackId)) ||
            Number(ref.providerTrackId) <= 0)
    )
        return [];
    return [`${ref.source}:${ref.providerTrackId}`];
}

/** Bounded inverse identity evidence; unavailable groups are not owner dislikes. */
export interface CanonicalFeedbackAliasCoverage {
    referencesByCanonicalKey: ReadonlyMap<string, ReadonlySet<string>>;
    uncertainReferencesByCanonicalKey: ReadonlyMap<string, ReadonlySet<string>>;
    unavailableCanonicalKeys: ReadonlySet<string>;
    unresolvedReferences: number;
    verifiedAliasReferences: number;
    lookupFailures: number;
}

/** Discover globally unambiguous, proven feedback aliases for the current finite pool. */
export async function collectVerifiedCanonicalFeedbackAliases(
    identities: readonly ResolvedCanonicalRecording[],
    check?: () => void,
): Promise<CanonicalFeedbackAliasCoverage> {
    const MAX_FAMILY = 16;
    const MAX_MAPPINGS = 32;
    const MAX_REFERENCES = 2048;
    const requested = new Map<string, Set<string>>();
    for (const identity of identities) {
        if (!identity.verifiedCanonicalKey) continue;
        const keys = requested.get(identity.id) ?? new Set<string>();
        keys.add(identity.verifiedCanonicalKey);
        requested.set(identity.id, keys);
    }
    const unavailable = new Set<string>();
    const result = new Map<string, ReadonlySet<string>>();
    const uncertain = new Map<string, ReadonlySet<string>>();
    let unresolvedReferences = 0;
    let lookupFailures = 0;
    const quota = Math.floor(MAX_REFERENCES / Math.max(1, requested.size));
    const pendingProofs = new Map<
        string,
        { ref: CanonicalProviderReference; groups: Set<string> }
    >();
    const proposed = new Map<
        string,
        { keys: Set<string>; refs: Map<string, CanonicalProviderReference> }
    >();
    const entries = [...requested].sort(([left], [right]) =>
        left.localeCompare(right),
    );
    for (let offset = 0; offset < entries.length; offset += 64) {
        check?.();
        const chunk = entries.slice(offset, offset + 64);
        const groups = new Map<
            string,
            { keys: Set<string>; family: Set<string> }
        >();
        const markUnavailable = (id: string) => {
            for (const key of new Set([
                ...(groups.get(id)?.keys ?? []),
                ...(proposed.get(id)?.keys ?? []),
                ...(requested.get(id) ?? []),
            ]))
                unavailable.add(key);
            groups.delete(id);
            proposed.delete(id);
        };
        try {
            const roots = await prisma.canonicalRecording.findMany({
                where: { id: { in: chunk.map(([id]) => id) } },
                take: chunk.length,
                select: canonicalAliasSelect,
            });
            check?.();
            for (const [id, keys] of chunk) {
                const row = roots.find((root) => root.id === id);
                if (!row || quota === 0) {
                    for (const key of keys) unavailable.add(key);
                    continue;
                }
                let survivor: CanonicalAliasRow;
                try {
                    survivor = await readCanonicalSurvivor(prisma, row, check);
                } catch {
                    check?.();
                    for (const key of keys) unavailable.add(key);
                    continue;
                }
                const group = groups.get(survivor.id) ?? {
                    keys: new Set<string>(),
                    family: new Set<string>([survivor.id]),
                };
                for (const key of keys) group.keys.add(key);
                group.keys.add(survivor.canonicalKey);
                group.family.add(id);
                groups.set(survivor.id, group);
            }
            let frontier = new Map(
                [...groups].flatMap(([id, group]) =>
                    [...group.family].map((member) => [member, id] as const),
                ),
            );
            const familyOwners = new Map(frontier);
            for (
                let depth = 0;
                frontier.size && depth < CANONICAL_MERGE_MAX_DEPTH;
                depth += 1
            ) {
                const next = new Map<string, string>();
                let retry = true;
                while (retry && groups.size) {
                    check?.();
                    const parents = [...frontier]
                        .filter(([, id]) => groups.has(id))
                        .map(([id]) => id);
                    if (!parents.length) break;
                    const bound = MAX_FAMILY * groups.size + 1;
                    const ancestors = await prisma.canonicalRecording.findMany({
                        where: {
                            mergedIntoId: { in: parents },
                            id: { notIn: [...familyOwners.keys()] },
                        },
                        take: bound,
                        select: canonicalAliasSelect,
                    });
                    check?.();
                    const overflow = new Set<string>();
                    for (const ancestor of ancestors) {
                        const owner = ancestor.mergedIntoId
                            ? frontier.get(ancestor.mergedIntoId)
                            : undefined;
                        const group = owner ? groups.get(owner) : undefined;
                        if (!owner || !group) continue;
                        group.family.add(ancestor.id);
                        familyOwners.set(ancestor.id, owner);
                        next.set(ancestor.id, owner);
                        if (group.family.size > MAX_FAMILY) overflow.add(owner);
                    }
                    for (const id of overflow) markUnavailable(id);
                    retry = ancestors.length === bound;
                    if (retry && overflow.size === 0)
                        throw new Error(
                            "Canonical ancestor coverage bound is ambiguous",
                        );
                }
                frontier = new Map(
                    [...next].filter(([, id]) => groups.has(id)),
                );
            }
            for (const id of new Set(frontier.values())) markUnavailable(id);
            let completeRows: MappingEvidence[] = [];
            while (groups.size) {
                check?.();
                const bound = MAX_MAPPINGS * groups.size + 1;
                const rows = await prisma.trackMapping.findMany({
                    where: {
                        canonicalRecordingId: {
                            in: [...groups.values()].flatMap((group) => [
                                ...group.family,
                            ]),
                        },
                        stale: false,
                        source: { in: ["manual", "isrc", "verified-source"] },
                    },
                    take: bound,
                    select: canonicalMappingSelect,
                });
                check?.();
                const counts = new Map<string, number>();
                for (const row of rows) {
                    const owner = row.canonicalRecording
                        ? familyOwners.get(row.canonicalRecording.id)
                        : undefined;
                    if (!owner || !groups.has(owner))
                        throw new Error(
                            "Canonical mapping coverage changed during read",
                        );
                    counts.set(owner, (counts.get(owner) ?? 0) + 1);
                }
                const overflow = [...counts]
                    .filter(([, count]) => count > MAX_MAPPINGS)
                    .map(([id]) => id);
                for (const id of overflow) markUnavailable(id);
                if (rows.length === bound) {
                    if (!overflow.length)
                        throw new Error(
                            "Canonical mapping coverage bound is ambiguous",
                        );
                    continue;
                }
                completeRows = rows;
                break;
            }
            const resolved = new Map<string, CanonicalAliasRow>();
            for (const row of completeRows) {
                if (!row.canonicalRecording) continue;
                const owner = familyOwners.get(row.canonicalRecording.id);
                if (!owner || !groups.has(owner)) continue;
                let survivor = resolved.get(row.canonicalRecording.id);
                if (!survivor) {
                    try {
                        survivor = await readCanonicalSurvivor(
                            prisma,
                            row.canonicalRecording,
                            check,
                        );
                    } catch {
                        check?.();
                        markUnavailable(owner);
                        continue;
                    }
                    resolved.set(row.canonicalRecording.id, survivor);
                }
                if (survivor.id !== owner) {
                    markUnavailable(owner);
                    continue;
                }
                const group = groups.get(owner)!;
                const evidence = proposed.get(owner) ?? {
                    keys: group.keys,
                    refs: new Map<string, CanonicalProviderReference>(),
                };
                for (const key of group.keys) evidence.keys.add(key);
                for (const ref of mappingReferences(row)) {
                    if (mappedIdentity(row, ref, survivor).verifiedCanonicalKey)
                        evidence.refs.set(
                            `${ref.source}:${ref.providerTrackId}`,
                            ref,
                        );
                    else unresolvedReferences += 1;
                }
                proposed.set(owner, evidence);
            }
            for (const [id, group] of groups) {
                const evidence = proposed.get(id);
                if (!evidence) continue;
                const keys = new Set(
                    [...evidence.refs.values()].flatMap(feedbackKeys),
                );
                if (keys.size > quota) {
                    markUnavailable(id);
                    proposed.delete(id);
                    continue;
                }
                for (const [refKey, ref] of evidence.refs) {
                    const pending = pendingProofs.get(refKey) ?? {
                        ref,
                        groups: new Set<string>(),
                    };
                    pending.groups.add(id);
                    pendingProofs.set(refKey, pending);
                }
                for (const key of group.keys) result.set(key, new Set());
            }
        } catch {
            check?.();
            lookupFailures += 1;
            for (const [, keys] of chunk)
                for (const key of keys) unavailable.add(key);
            for (const group of groups.values())
                for (const key of group.keys) unavailable.add(key);
        }
    }
    check?.();
    const pending = [...pendingProofs.values()];
    try {
        const failures = new Map<
            string,
            "missing" | "unverified" | "ambiguous" | "overflow" | "broken-alias"
        >();
        const verified = await findVerifiedCanonicalReferences(
            pending.map((entry) => entry.ref),
            check,
            (ref, reason) =>
                failures.set(`${ref.source}:${ref.providerTrackId}`, reason),
        );
        for (let index = 0; index < pending.length; index += 1) {
            const proof = verified[index];
            for (const id of pending[index].groups) {
                const group = proposed.get(id);
                const reason = failures.get(
                    `${pending[index].ref.source}:${pending[index].ref.providerTrackId}`,
                );
                if (
                    group &&
                    (reason === "overflow" || reason === "broken-alias")
                ) {
                    for (const key of group.keys) {
                        const values = new Set(uncertain.get(key));
                        for (const ref of feedbackKeys(pending[index].ref))
                            values.add(ref);
                        uncertain.set(key, values);
                    }
                }
                if (!group || !proof || proof.id !== id) {
                    unresolvedReferences += 1;
                    continue;
                }
                for (const key of group.keys) {
                    if (unavailable.has(key)) continue;
                    const values = new Set(result.get(key));
                    for (const ref of feedbackKeys(pending[index].ref))
                        values.add(ref);
                    result.set(key, values);
                }
            }
        }
    } catch {
        check?.();
        lookupFailures += 1;
        for (const entry of pending)
            for (const id of entry.groups) {
                for (const key of proposed.get(id)?.keys ?? []) {
                    const values = new Set(uncertain.get(key));
                    for (const ref of feedbackKeys(entry.ref)) values.add(ref);
                    uncertain.set(key, values);
                }
            }
    }
    for (const key of unavailable) {
        result.delete(key);
        uncertain.delete(key);
    }
    return {
        referencesByCanonicalKey: result,
        uncertainReferencesByCanonicalKey: uncertain,
        unavailableCanonicalKeys: unavailable,
        unresolvedReferences,
        verifiedAliasReferences: new Set(
            [...result.values()].flatMap((refs) => [...refs]),
        ).size,
        lookupFailures,
    };
}

function normalizedIsrc(value: string | null | undefined): string | null {
    const normalized = value?.replace(/[^a-z0-9]/giu, "").toUpperCase();
    return normalized && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized)
        ? normalized
        : null;
}

function normalizedMbid(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return isValidMbid(trimmed) ? trimmed.toLowerCase() : null;
}

function compatibleRecording(
    facts: { title: string; artist: string; duration: number },
    canonical: CanonicalAliasRow,
): boolean {
    // Exact normalized titles preserve version words (live/remaster/cover/etc.).
    // The 12-second bound is the existing durable lookup compatibility bound.
    const title = (value: string) =>
        normalizedText(
            value.replace(
                /[\[(](?:official\s+)?(?:music\s+)?(?:video|audio|lyric\s+video|lyrics|visuali[sz]er)[\])]/giu,
                " ",
            ),
        );
    return Boolean(
        canonical.title &&
        canonical.artist &&
        title(facts.title) === title(canonical.title) &&
        normalizedText(facts.artist) === normalizedText(canonical.artist) &&
        Number.isFinite(facts.duration) &&
        facts.duration > 0 &&
        typeof canonical.duration === "number" &&
        Number.isFinite(canonical.duration) &&
        canonical.duration > 0 &&
        Math.abs(facts.duration - canonical.duration) <= 12,
    );
}

function mappedIdentity(
    row: MappingEvidence,
    ref: CanonicalProviderReference,
    survivor: CanonicalAliasRow,
): ResolvedCanonicalRecording {
    const identity: ResolvedCanonicalRecording = {
        id: survivor.id,
        canonicalKey: survivor.canonicalKey,
    };
    const native = readVerifiedMusicSourceRecording(row.trackMusicSource);
    const local = row.track && {
        ...row.track,
        artist: row.track.album?.artist.name ?? "",
    };
    const facts =
        ref.source === "youtube"
            ? row.trackYtMusic
            : ref.source === "tidal"
              ? row.trackTidal
              : ref.source === "library"
                ? local
                : native &&
                    native.provider === ref.source &&
                    native.id === ref.providerTrackId
                  ? { ...native, artist: native.artists.join(" ") }
                  : null;
    const nativeReference = ref.source === "vk" || ref.source === "yandex";
    const nativeExact =
        nativeReference &&
        native &&
        row.source === "verified-source" &&
        row.confidence === 1 &&
        survivor.canonicalKey === `provider:${native.provider}:${native.id}`;
    if (nativeExact) {
        identity.verifiedCanonicalKey = survivor.canonicalKey;
        return identity;
    }
    if (!facts || !compatibleRecording(facts, survivor)) return identity;
    const durableProvenance = [
        "acoustid",
        "musicbrainz-isrc",
        "tidal-isrc",
        "import-isrc",
    ].includes(survivor.identitySource ?? "");
    const nativeFacts = native && {
        ...native,
        artist: native.artists.join(" "),
    };
    // Tuple provenance cannot prove a local row attached later by metadata reconciliation.
    // Own durable facts are mandatory for providers that expose them; YouTube uses
    // its explicit verified tuple, whose identified counterparts must all agree.
    const sources =
        ref.source === "youtube"
            ? [nativeFacts, row.trackTidal, local]
            : ref.source === "tidal"
              ? [row.trackTidal]
              : ref.source === "library"
                ? [local]
                : [nativeFacts];
    const durableFacts = sources
        .filter((stored): stored is NonNullable<typeof stored> =>
            Boolean(stored),
        )
        .filter((stored) =>
            Boolean(
                stored.isrc?.trim() ||
                ("recordingMbid" in stored &&
                    typeof stored.recordingMbid === "string" &&
                    stored.recordingMbid.trim()),
            ),
        );
    const canonicalMbid = normalizedMbid(survivor.recordingMbid);
    const matchesDurableFacts =
        durableFacts.length > 0 &&
        durableFacts.every((stored) => {
            const mbid =
                "recordingMbid" in stored &&
                typeof stored.recordingMbid === "string"
                    ? normalizedMbid(stored.recordingMbid)
                    : null;
            const isrc = normalizedIsrc(stored.isrc);
            return (
                compatibleRecording(stored, survivor) &&
                !(mbid && canonicalMbid && mbid !== canonicalMbid) &&
                ((mbid !== null && mbid === canonicalMbid) ||
                    (isrc !== null && isrc === normalizedIsrc(survivor.isrc)))
            );
        });
    // A promoted canonical does not retroactively prove its old metadata edges.
    const durableEdge =
        durableProvenance &&
        matchesDurableFacts &&
        ((row.source === "manual" && row.confidence === 1) ||
            (row.source === "isrc" &&
                row.confidence <= 1 &&
                isProviderMappingEligible({
                    confidence: row.confidence,
                    expectedDurationSeconds: survivor.duration ?? Number.NaN,
                    actualDurationSeconds: facts.duration,
                })) ||
            (nativeReference &&
                row.source === "verified-source" &&
                row.confidence === 1 &&
                native));
    if (durableEdge) identity.verifiedCanonicalKey = survivor.canonicalKey;
    return identity;
}

/** Resolve only evidenced aliases for current feedback; missing/stale rows stay neutral. */
export async function findVerifiedCanonicalReferences(
    references: readonly CanonicalProviderReference[],
    check?: () => void,
    onUnresolved?: (
        reference: CanonicalProviderReference,
        reason:
            | "missing"
            | "unverified"
            | "ambiguous"
            | "overflow"
            | "broken-alias",
    ) => void,
): Promise<Array<ResolvedCanonicalRecording | null>> {
    const mapped = await readMappedCanonicalReferences(
        references,
        check,
        onUnresolved,
    );
    return mapped.map((identity, index) => {
        if (identity?.verifiedCanonicalKey) return identity;
        if (identity) onUnresolved?.(references[index], "unverified");
        return null;
    });
}

/**
 * Read known provider identities in bounded batches, preserving input positions.
 * Legacy misses use the ordinary resolver; native misses remain neutral and read-only.
 * The result is request-local: merges and stale flags are never globally cached.
 */
export async function findMappedCanonicalCandidates(
    candidates: readonly RecommendationCandidate[],
    check?: () => void,
): Promise<Array<ResolvedCanonicalRecording | null>> {
    check?.();
    return readMappedCanonicalReferences(
        candidates.map((candidate) => ({
            source: candidate.source,
            providerTrackId: providerTrackId(candidate) ?? "",
        })),
        check,
    );
}

/** A failed proof read cannot be confused with a complete, neutral identity miss. */
export interface CanonicalCandidateEvidenceRead {
    recordings: Array<ResolvedCanonicalRecording | null>;
    unavailableCandidateIndexes: ReadonlySet<number>;
    lookupFailures: number;
}

/**
 * Read current-pool hard-negative evidence without the soft resolver's null fallback.
 * Split truncated batches so a crowded provider reference cannot hide a healthy peer.
 * At most 32 mappings per reference are admitted; the extra row proves overflow.
 * A 64-reference chunk has at most 127 binary-split reads, including its first read.
 */
export async function readCanonicalCandidateEvidence(
    candidates: readonly RecommendationCandidate[],
    check?: () => void,
): Promise<CanonicalCandidateEvidenceRead> {
    check?.();
    const byReference = new Map<string, CanonicalProviderReference>();
    const references = candidates.map((candidate) => ({
        source: candidate.source,
        providerTrackId: providerTrackId(candidate) ?? "",
    }));
    const key = (reference: CanonicalProviderReference) =>
        `${reference.source}:${reference.providerTrackId}`;
    for (const reference of references)
        byReference.set(key(reference), reference);
    const unique = [...byReference.values()].sort((a, b) =>
        key(a).localeCompare(key(b)),
    );
    const resolved = new Map<string, ResolvedCanonicalRecording | null>();
    const unavailable = new Set<string>();
    let lookupFailures = 0;
    let lookupUnavailable = false;
    const read = async (
        batch: CanonicalProviderReference[],
        budget: { remaining: number },
    ): Promise<void> => {
        check?.();
        if (lookupUnavailable || budget.remaining === 0) {
            for (const reference of batch) unavailable.add(key(reference));
            return;
        }
        budget.remaining -= 1;
        const failures = new Map<string, string>();
        let batchTruncated = false;
        let mapped: Array<ResolvedCanonicalRecording | null>;
        try {
            mapped = await readMappedCanonicalReferences(
                batch,
                check,
                (reference, reason) => failures.set(key(reference), reason),
                {
                    maxMappingsPerReference: 32,
                    onBatchTruncated: () => {
                        batchTruncated = true;
                    },
                },
            );
        } catch {
            check?.();
            // Do not multiply an unavailable DB read into per-reference retries.
            lookupFailures += 1;
            lookupUnavailable = true;
            for (const reference of batch) unavailable.add(key(reference));
            return;
        }
        check?.();
        if (batchTruncated && batch.length > 1) {
            const middle = Math.floor(batch.length / 2);
            await read(batch.slice(0, middle), budget);
            await read(batch.slice(middle), budget);
            return;
        }
        for (const [index, reference] of batch.entries()) {
            const reason = failures.get(key(reference));
            if (reason === "overflow" || reason === "broken-alias")
                unavailable.add(key(reference));
            resolved.set(key(reference), mapped[index]);
        }
    };
    for (let offset = 0; offset < unique.length; offset += 64) {
        const batch = unique.slice(offset, offset + 64);
        await read(batch, { remaining: batch.length * 2 - 1 });
    }
    check?.();
    return {
        recordings: references.map(
            (reference) => resolved.get(key(reference)) ?? null,
        ),
        unavailableCandidateIndexes: new Set(
            references.flatMap((reference, index) =>
                unavailable.has(key(reference)) ? [index] : [],
            ),
        ),
        lookupFailures,
    };
}

async function readMappedCanonicalReferences(
    references: readonly CanonicalProviderReference[],
    check?: () => void,
    onUnresolved?: (
        reference: CanonicalProviderReference,
        reason:
            | "missing"
            | "unverified"
            | "ambiguous"
            | "overflow"
            | "broken-alias",
    ) => void,
    strictEvidence?: {
        maxMappingsPerReference: number;
        onBatchTruncated: () => void;
    },
): Promise<Array<ResolvedCanonicalRecording | null>> {
    check?.();
    const result: Array<ResolvedCanonicalRecording | null> = [];
    for (let offset = 0; offset < references.length; offset += 250) {
        check?.();
        const batch = references.slice(offset, offset + 250);
        const ids = (source: RecommendationCandidate["source"]) => [
            ...new Set(
                batch
                    .filter((c) => c.source === source)
                    .map((reference) => reference.providerTrackId)
                    .filter((id): id is string => Boolean(id)),
            ),
        ];
        const youtube = ids("youtube");
        const tidal = ids("tidal").map(Number).filter(Number.isSafeInteger);
        const library = ids("library");
        const native = (["vk", "yandex"] as const).flatMap((provider) => {
            const providerTrackIds = ids(provider);
            return providerTrackIds.length
                ? [
                      {
                          trackMusicSource: {
                              is: {
                                  provider,
                                  providerTrackId: { in: providerTrackIds },
                                  verifiedMetadata: { not: Prisma.AnyNull },
                                  metadataObservedAt: { not: null },
                                  metadataConnectionVersion: { gt: 0 },
                              },
                          },
                      },
                  ]
                : [];
        });
        const filters: Prisma.TrackMappingWhereInput[] = [
            ...native,
            ...(youtube.length
                ? [{ trackYtMusic: { is: { videoId: { in: youtube } } } }]
                : []),
            ...(tidal.length
                ? [{ trackTidal: { is: { tidalId: { in: tidal } } } }]
                : []),
            ...(library.length
                ? [{ track: { is: { id: { in: library } } } }]
                : []),
        ];
        if (!filters.length) {
            for (const reference of batch) onUnresolved?.(reference, "missing");
            result.push(...batch.map(() => null));
            continue;
        }
        const bound =
            strictEvidence !== undefined
                ? batch.length * strictEvidence.maxMappingsPerReference + 1
                : batch.length * 4;
        const rows = await prisma.trackMapping.findMany({
            where: {
                OR: filters,
                stale: false,
                canonicalRecordingId: { not: null },
            },
            take: bound,
            select: canonicalMappingSelect,
        });
        check?.();
        // A truncated duplicate set cannot prove an unambiguous identity.
        if (rows.length === bound) {
            if (strictEvidence && batch.length > 1)
                strictEvidence.onBatchTruncated();
            else
                for (const reference of batch)
                    onUnresolved?.(reference, "overflow");
            result.push(...batch.map(() => null));
            continue;
        }
        const mapped = new Map<string, ResolvedCanonicalRecording | null>();
        const failures = new Map<
            string,
            "missing" | "unverified" | "ambiguous" | "overflow" | "broken-alias"
        >();
        const survivors = new Map<string, CanonicalAliasRow | null>();
        const counts = new Map<string, number>();
        for (const row of rows) {
            if (!row.canonicalRecording) continue;
            const initial = row.canonicalRecording;
            if (!survivors.has(initial.id)) {
                try {
                    survivors.set(
                        initial.id,
                        await readCanonicalSurvivor(prisma, initial, check),
                    );
                } catch {
                    check?.();
                    survivors.set(initial.id, null);
                }
            }
            const survivor = survivors.get(initial.id);
            for (const ref of mappingReferences(row)) {
                const key = `${ref.source}:${ref.providerTrackId}`;
                counts.set(key, (counts.get(key) ?? 0) + 1);
                const resolved = survivor
                    ? mappedIdentity(row, ref, survivor)
                    : null;
                // Namespace identity can support soft scoring; a hard negative
                // additionally needs verified cross-provider recording proof.
                const identity =
                    strictEvidence !== undefined &&
                    (ref.source === "vk" || ref.source === "yandex") &&
                    !resolved?.verifiedCanonicalKey
                        ? null
                        : resolved;
                const existing = mapped.get(key);
                if (!survivor) failures.set(key, "broken-alias");
                else if (
                    !identity &&
                    failures.get(key) !== "broken-alias" &&
                    failures.get(key) !== "ambiguous"
                )
                    failures.set(key, "unverified");
                if (
                    existing !== undefined &&
                    existing?.id !== identity?.id &&
                    failures.get(key) !== "broken-alias"
                )
                    failures.set(key, "ambiguous");
                mapped.set(
                    key,
                    existing !== undefined && existing?.id !== identity?.id
                        ? null
                        : existing?.verifiedCanonicalKey
                          ? existing
                          : identity,
                );
            }
        }
        for (const candidate of batch) {
            check?.();
            const key = `${candidate.source}:${candidate.providerTrackId}`;
            const overflow =
                strictEvidence !== undefined &&
                (counts.get(key) ?? 0) > strictEvidence.maxMappingsPerReference;
            const identity = overflow ? null : mapped.get(key);
            if (!identity)
                onUnresolved?.(
                    candidate,
                    overflow ? "overflow" : (failures.get(key) ?? "missing"),
                );
            result.push(identity ?? null);
        }
    }
    check?.();
    return result;
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
