import type {
    RecommendationCandidate,
    RecommendationDirection,
    RecommendationExposureSignal,
    RecommendationMood,
    ScoredRecommendation,
} from "./types";

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const MAX_TRACKS_PER_ARTIST = 2;
const MAX_TRACKS_PER_ALBUM = 2;

function normalizeVector(vector: readonly number[]): number[] | null {
    if (
        vector.length === 0 ||
        vector.some((value) => !Number.isFinite(value))
    ) {
        return null;
    }
    const norm = Math.sqrt(
        vector.reduce((sum, value) => sum + value * value, 0),
    );
    if (norm <= Number.EPSILON) return null;
    return vector.map((value) => value / norm);
}

function cosine(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    for (let index = 0; index < a.length; index += 1) {
        dot += a[index] * b[index];
    }
    return Math.max(-1, Math.min(1, dot));
}

/** Deterministic compact multi-centroid profile for several taste directions. */
export function buildTasteCentroids(
    rawVectors: readonly (readonly number[])[],
    maxCentroids = 5,
): number[][] {
    const vectors = rawVectors
        .map(normalizeVector)
        .filter((vector): vector is number[] => vector !== null);
    if (vectors.length === 0) return [];
    const clusterCount = Math.min(
        Math.max(1, maxCentroids),
        Math.max(1, Math.ceil(vectors.length / 2)),
    );
    const centers: number[][] = [[...vectors[0]]];
    while (centers.length < clusterCount) {
        let bestVector = vectors[0];
        let lowestAffinity = Number.POSITIVE_INFINITY;
        for (const vector of vectors) {
            const affinity = Math.max(
                ...centers.map((center) => cosine(vector, center)),
            );
            if (affinity < lowestAffinity) {
                lowestAffinity = affinity;
                bestVector = vector;
            }
        }
        centers.push([...bestVector]);
    }

    for (let iteration = 0; iteration < 5; iteration += 1) {
        const groups = centers.map(() => [] as number[][]);
        for (const vector of vectors) {
            let winner = 0;
            let best = Number.NEGATIVE_INFINITY;
            centers.forEach((center, index) => {
                const similarity = cosine(vector, center);
                if (similarity > best) {
                    best = similarity;
                    winner = index;
                }
            });
            groups[winner].push(vector);
        }
        groups.forEach((group, index) => {
            if (group.length === 0) return;
            const mean = Array.from({ length: group[0].length }, () => 0);
            for (const vector of group) {
                vector.forEach((value, dimension) => {
                    mean[dimension] += value;
                });
            }
            const normalized = normalizeVector(
                mean.map((value) => value / group.length),
            );
            if (normalized) centers[index] = normalized;
        });
    }
    return centers;
}

function stableUnitInterval(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0) / 4_294_967_295;
}

function moodFeatureScore(
    candidate: RecommendationCandidate,
    mood: RecommendationMood | null,
): number {
    if (!mood) return candidate.moodSimilarity ?? 0;
    if (candidate.moodSimilarity !== undefined) return candidate.moodSimilarity;
    const features = candidate.audioFeatures;
    if (!features) return 0;
    const energy = features.energy ?? 0.5;
    const valence = features.valence ?? 0.5;
    const danceability = features.danceability ?? 0.5;
    const instrumentalness = features.instrumentalness ?? 0.5;
    switch (mood) {
        case "calm":
            return (1 - energy) * 0.7 + instrumentalness * 0.3;
        case "energetic":
            return energy * 0.7 + danceability * 0.3;
        case "focus":
            return (
                instrumentalness * 0.6 +
                (1 - danceability) * 0.2 +
                (1 - Math.abs(energy - 0.45)) * 0.2
            );
        case "workout":
            return energy * 0.55 + danceability * 0.45;
        case "favorites":
            return candidate.accountAffinity ?? 0;
        case "forgotten":
            return valence * 0.1;
    }
}

function latestExposureAge(
    key: string,
    exposures: readonly RecommendationExposureSignal[],
    now: Date,
): number | null {
    let newest = Number.NEGATIVE_INFINITY;
    for (const exposure of exposures) {
        if (exposure.canonicalKey !== key) continue;
        newest = Math.max(newest, exposure.exposedAt.getTime());
    }
    return Number.isFinite(newest) ? Math.max(0, now.getTime() - newest) : null;
}

function candidateSimilarity(
    left: RecommendationCandidate,
    right: RecommendationCandidate,
): number {
    if (left.canonicalKey === right.canonicalKey) return 1;
    const leftArtist = left.artist.name.trim().toLocaleLowerCase();
    const rightArtist = right.artist.name.trim().toLocaleLowerCase();
    if (leftArtist && leftArtist === rightArtist) return 0.82;
    const leftAlbum = left.album.title.trim().toLocaleLowerCase();
    const rightAlbum = right.album.title.trim().toLocaleLowerCase();
    if (leftAlbum && leftAlbum === rightAlbum) return 0.9;
    if (left.embedding && right.embedding) {
        const a = normalizeVector(left.embedding);
        const b = normalizeVector(right.embedding);
        if (a && b) return Math.max(0, cosine(a, b));
    }
    return 0;
}

function baseScore(
    candidate: RecommendationCandidate,
    options: RankRecommendationOptions,
): number {
    let score = candidate.providerPrior + (candidate.accountAffinity ?? 0);
    score += moodFeatureScore(candidate, options.mood) * 0.8;
    const vector = candidate.embedding
        ? normalizeVector(candidate.embedding)
        : null;
    if (vector && options.positiveCentroids.length > 0) {
        score +=
            Math.max(
                ...options.positiveCentroids.map((center) =>
                    cosine(vector, center),
                ),
            ) * 1.35;
    }
    if (vector && options.negativeCentroids.length > 0) {
        score -=
            Math.max(
                0,
                ...options.negativeCentroids.map((center) =>
                    cosine(vector, center),
                ),
            ) * 0.4;
    }
    const moodVector = options.moodEmbedding
        ? normalizeVector(options.moodEmbedding)
        : null;
    if (vector && moodVector && vector.length === moodVector.length) {
        score += cosine(vector, moodVector) * 0.9;
    }
    const exposureAge = latestExposureAge(
        candidate.canonicalKey,
        options.exposures,
        options.now,
    );
    if (exposureAge !== null && exposureAge < SEVEN_DAYS_MS) {
        score -= 2 * (1 - exposureAge / SEVEN_DAYS_MS);
    }
    const exploration =
        stableUnitInterval(`${options.sessionId}:${candidate.canonicalKey}`) -
        0.5;
    if (options.direction === "new") score += exploration * 0.7;
    else if (options.direction === "for-you") score += exploration * 0.04;
    return score;
}

export interface RankRecommendationOptions {
    now: Date;
    limit: number;
    perLaneLimit?: number;
    sessionId: string;
    direction: RecommendationDirection;
    mood: RecommendationMood | null;
    dislikedCanonicalKeys: ReadonlySet<string>;
    exposures: readonly RecommendationExposureSignal[];
    positiveCentroids: readonly (readonly number[])[];
    negativeCentroids: readonly (readonly number[])[];
    moodEmbedding?: readonly number[] | null;
}

/**
 * Final hard-filter, repeat-control and MMR pass shared by every personalized
 * surface. It is pure so shadow and served ranks use identical policy.
 */
export function rankRecommendationCandidates(
    candidates: readonly RecommendationCandidate[],
    options: RankRecommendationOptions,
): ScoredRecommendation[] {
    const fresh = rankRecommendationCandidatePool(candidates, options, true);
    const shouldBackfillRecent =
        fresh.length === 0 ||
        (options.perLaneLimit !== undefined && fresh.length < options.limit);
    if (!shouldBackfillRecent) return fresh;
    return rankRecommendationCandidatePool(candidates, options, false, fresh);
}

function rankRecommendationCandidatePool(
    candidates: readonly RecommendationCandidate[],
    options: RankRecommendationOptions,
    enforceOneDayCooldown: boolean,
    initialSelections: readonly ScoredRecommendation[] = [],
): ScoredRecommendation[] {
    const selectedCanonicalKeys = new Set(
        initialSelections.map(({ track }) => track.canonicalKey),
    );
    const bestByCanonical = new Map<string, RecommendationCandidate>();
    for (const candidate of candidates) {
        if (selectedCanonicalKeys.has(candidate.canonicalKey)) continue;
        if (options.dislikedCanonicalKeys.has(candidate.canonicalKey)) continue;
        const providerTrackId =
            candidate.provider.youtubeVideoId ??
            candidate.provider.tidalTrackId?.toString() ??
            (candidate.source === "library" ? candidate.id : null);
        if (!providerTrackId) continue;
        const age = latestExposureAge(
            candidate.canonicalKey,
            options.exposures,
            options.now,
        );
        if (enforceOneDayCooldown && age !== null && age < ONE_DAY_MS) continue;
        const existing = bestByCanonical.get(candidate.canonicalKey);
        if (!existing || candidate.providerPrior > existing.providerPrior) {
            bestByCanonical.set(candidate.canonicalKey, candidate);
        }
    }

    const scored = [...bestByCanonical.values()]
        .map((track) => ({ track, score: baseScore(track, options) }))
        .sort(
            (left, right) =>
                right.score - left.score ||
                left.track.canonicalKey.localeCompare(right.track.canonicalKey),
        );
    const selected: ScoredRecommendation[] = [...initialSelections];
    const artistCounts = new Map<string, number>();
    const albumCounts = new Map<string, number>();
    const laneCounts = new Map<
        NonNullable<RecommendationCandidate["lane"]>,
        number
    >();
    const normalizedPerLaneLimit =
        options.perLaneLimit !== undefined &&
        Number.isFinite(options.perLaneLimit)
            ? Math.max(0, Math.floor(options.perLaneLimit))
            : null;

    for (const picked of selected) {
        const artistKey = picked.track.artist.name.trim().toLocaleLowerCase();
        const albumKey = `${artistKey}:${picked.track.album.title
            .trim()
            .toLocaleLowerCase()}`;
        artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
        albumCounts.set(albumKey, (albumCounts.get(albumKey) ?? 0) + 1);
        if (picked.track.lane) {
            laneCounts.set(
                picked.track.lane,
                (laneCounts.get(picked.track.lane) ?? 0) + 1,
            );
        }
    }

    while (selected.length < options.limit) {
        let bestIndex = -1;
        let bestMmr = Number.NEGATIVE_INFINITY;
        scored.forEach((entry, index) => {
            const artistKey = entry.track.artist.name
                .trim()
                .toLocaleLowerCase();
            const albumKey = `${artistKey}:${entry.track.album.title
                .trim()
                .toLocaleLowerCase()}`;
            if ((artistCounts.get(artistKey) ?? 0) >= MAX_TRACKS_PER_ARTIST) {
                return;
            }
            if ((albumCounts.get(albumKey) ?? 0) >= MAX_TRACKS_PER_ALBUM)
                return;
            if (
                entry.track.lane &&
                normalizedPerLaneLimit !== null &&
                (laneCounts.get(entry.track.lane) ?? 0) >=
                    normalizedPerLaneLimit
            ) {
                return;
            }
            const redundancy = selected.length
                ? Math.max(
                      ...selected.map((picked) =>
                          candidateSimilarity(entry.track, picked.track),
                      ),
                  )
                : 0;
            const mmr = entry.score - redundancy * 0.42;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIndex = index;
            }
        });
        if (bestIndex < 0) break;
        const [winner] = scored.splice(bestIndex, 1);
        selected.push(winner);
        const artistKey = winner.track.artist.name.trim().toLocaleLowerCase();
        const albumKey = `${artistKey}:${winner.track.album.title
            .trim()
            .toLocaleLowerCase()}`;
        artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
        albumCounts.set(albumKey, (albumCounts.get(albumKey) ?? 0) + 1);
        if (winner.track.lane) {
            laneCounts.set(
                winner.track.lane,
                (laneCounts.get(winner.track.lane) ?? 0) + 1,
            );
        }
    }
    return selected;
}
