import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { readVerifiedMusicSourceRecording } from "../musicSources/verifiedMetadata";
import { findMappedCanonicalCandidates } from "./canonicalIdentity";
import { toNativeRecommendationCandidate } from "./nativeCandidates";
import type { RecommendationCandidate } from "./types";

function reference(value: string) {
    const match = /^(vk|yandex):(.+)$/.exec(value);
    if (!match) return null;
    const provider = match[1] as "vk" | "yandex",
        id = match[2];
    return (provider === "vk" ? /^-?\d{1,20}_\d{1,20}$/ : /^\d{1,20}$/).test(id)
        ? { provider, id, key: value }
        : null;
}
function references(values: readonly string[]) {
    return [...new Set(values.slice(0, 2000))].flatMap(
        (value) => reference(value) ?? [],
    );
}

/** Provider-scoped whole ordered credits; guest names and ambiguous joins are never separate bans. */
export function nativeArtistCreditKey(value: unknown): string | null {
    const candidate = toNativeRecommendationCandidate(
        value,
        "native-credit-policy",
    );
    if (!candidate?.musicSourceRecording) return null;
    const recording = candidate.musicSourceRecording;
    const artists = recording.artists.map((name) =>
        name.normalize("NFKC").trim().toLocaleLowerCase("en-US"),
    );
    if (artists.some((name) => name === "unknown" || name === "unknown artist"))
        return null;
    return JSON.stringify([recording.provider, artists]);
}

/** Read only confirmed stored namespaces for exact references, preserving requested order and zeroes. */
export async function loadVerifiedNativeCandidates(
    values: readonly string[],
    check: () => void = () => {},
): Promise<RecommendationCandidate[]> {
    check();
    const refs = references(values),
        found = new Map<string, RecommendationCandidate>();
    for (let offset = 0; offset < refs.length; offset += 250) {
        check();
        const batch = refs.slice(offset, offset + 250),
            requested = new Set(batch.map((ref) => ref.key));
        const rows = await prisma.trackMusicSource.findMany({
            where: {
                verifiedMetadata: { not: Prisma.AnyNull },
                metadataObservedAt: { not: null },
                metadataConnectionVersion: { gt: 0 },
                OR: (["vk", "yandex"] as const).flatMap((provider) => {
                    const ids = batch
                        .filter((ref) => ref.provider === provider)
                        .map((ref) => ref.id);
                    return ids.length
                        ? [{ provider, providerTrackId: { in: ids } }]
                        : [];
                }),
            },
            take: batch.length,
            select: {
                provider: true,
                providerTrackId: true,
                verifiedMetadata: true,
                metadataObservedAt: true,
                metadataConnectionVersion: true,
            },
        });
        check();
        for (const row of rows) {
            const recording = readVerifiedMusicSourceRecording(row);
            if (
                !recording ||
                !requested.has(`${recording.provider}:${recording.id}`)
            )
                continue;
            const candidate = toNativeRecommendationCandidate(
                recording,
                "native-owned-policy",
            );
            if (candidate) found.set(candidate.id, candidate);
        }
    }
    check();
    return refs.flatMap((ref) => found.get(ref.key) ?? []);
}

/** Exact active owner dislikes do not require shared canonical identity, analysis or display metadata. */
export async function loadDislikedNativeRecordingIds(
    userId: string,
    values: readonly string[],
    policyTime: Date,
    check: () => void = () => {},
): Promise<Set<string>> {
    check();
    const refs = references(values),
        disliked = new Set<string>();
    for (let offset = 0; offset < refs.length; offset += 250) {
        check();
        const keys = refs.slice(offset, offset + 250).map((ref) => ref.key),
            requested = new Set(keys);
        const rows = await prisma.dislikedEntity.findMany({
            where: {
                userId,
                entityType: "track",
                entityId: { in: keys },
                dislikedAt: { lte: policyTime },
            },
            take: keys.length,
            select: { entityId: true },
        });
        check();
        for (const row of rows)
            if (requested.has(row.entityId)) disliked.add(row.entityId);
    }
    return disliked;
}

/** Two distinct active recordings within thirty days suppress their confirmed complete credit per provider. */
export async function loadSuppressedNativeArtistCredits(
    userId: string,
    policyTime: Date,
    check: () => void = () => {},
): Promise<Set<string>> {
    check();
    const since = new Date(policyTime.getTime() - 30 * 86_400_000),
        refs = new Set<string>();
    for (const provider of ["vk", "yandex"] as const) {
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
            check();
            const rows = await prisma.dislikedEntity.findMany({
                where: {
                    userId,
                    entityType: "track",
                    entityId: { startsWith: `${provider}:` },
                    dislikedAt: { gte: since, lte: policyTime },
                },
                orderBy: [{ dislikedAt: "desc" }, { id: "asc" }],
                take: 100,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                select: { id: true, entityId: true, dislikedAt: true },
            });
            check();
            for (const row of rows) {
                const ref = reference(row.entityId);
                if (
                    ref?.provider === provider &&
                    row.dislikedAt instanceof Date &&
                    row.dislikedAt >= since &&
                    row.dislikedAt <= policyTime
                )
                    refs.add(ref.key);
            }
            if (rows.length < 100 || !rows.at(-1)?.id) break;
            cursor = rows.at(-1)!.id;
        }
    }
    const candidates = await loadVerifiedNativeCandidates([...refs], check);
    check();
    const mappings = await findMappedCanonicalCandidates(candidates, check);
    check();
    const byCredit = new Map<string, Set<string>>();
    candidates.forEach((candidate, index) => {
        const key = nativeArtistCreditKey(candidate.musicSourceRecording);
        if (!key) return;
        const recordings = byCredit.get(key) ?? new Set<string>();
        const mapped = mappings[index];
        recordings.add(
            JSON.stringify(
                mapped ? ["canonical", mapped.id] : ["provider", candidate.id],
            ),
        );
        byCredit.set(key, recordings);
    });
    return new Set(
        [...byCredit].flatMap(([key, recordings]) =>
            recordings.size >= 2 ? [key] : [],
        ),
    );
}
