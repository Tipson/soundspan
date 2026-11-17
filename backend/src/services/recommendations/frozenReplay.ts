import type {
    RecommendationEngineDependencies,
    RecommendationEngineMode,
    RecommendationTasteContext,
    RecordEngineGenerationInput,
} from "./engine";
import type {
    RecommendationEvaluationGenerationSample,
    RecommendationShadowEvaluationReport,
} from "./shadowEvaluation";
import type {
    RecommendRequest,
    RecommendationCandidate,
    ScoredRecommendation,
} from "./types";
import {
    buildRecommendationAlbumKey,
    normalizeRecommendationArtistKey,
} from "./identityKeys";

/** Maximum encoded fixture size; file readers must enforce this before JSON parsing. */
export const MAX_FROZEN_RECOMMENDATION_REPLAY_BYTES = 2 * 1024 * 1024;

/** Synthetic source metadata; canonical identity is supplied by the fixture adapter. */
export interface FrozenReplayCandidateV1 {
    id: string;
    recordingKey?: string;
    artist: string;
    album: string;
    source: "youtube" | "library";
    providerPrior: number;
    accountAffinity?: number;
    embedding?: number[] | null;
    audioFeatures?: RecommendationCandidate["audioFeatures"];
    lane?: RecommendationCandidate["lane"];
}

/** Explicit observations apply only to the served generation of the named run. */
export interface FrozenReplayObservationV1 {
    runId: string;
    candidateId: string;
    viewed: boolean;
    outcome?: "completed" | "meaningful" | "skipped" | "failed";
    listenedSeconds?: number;
    completionRatio?: number;
}

/**
 * Version 1 sanitized synthetic pool, viewed history, taste and fixed request.
 * All candidate references use fixture IDs; no account ID, URL or provider-supplied
 * canonical identifier is accepted. Vectors share one dimension, at most 2048.
 */
export interface FrozenRecommendationReplayV1 {
    version: 1;
    nowISO: string;
    request: Pick<
        RecommendRequest,
        "sessionId" | "intent" | "limit" | "perLaneLimit" | "cursor" | "exclude"
    >;
    candidates: FrozenReplayCandidateV1[];
    signals: {
        dislikedCandidateIds: string[];
        unavailableCandidateIds: string[];
        savedCandidateIds: string[];
        repeatCandidateIds: string[];
        hardRepeatCandidateIds: string[];
        /** These are explicitly viewed impressions, never inferred listening. */
        recentExposures: { candidateId: string; exposedAtISO: string }[];
    };
    taste: RecommendationTasteContext;
    config: {
        rolloutPercents: number[];
        explorationRate: number;
        featureFailure?: boolean;
        tasteFailure?: boolean;
    };
    observations?: FrozenReplayObservationV1[];
}

/** Actual in-memory engine write in its persisted order, with optional diagnostics. */
export interface FrozenReplayGenerationV1 {
    id: string;
    algorithm: RecordEngineGenerationInput["algorithm"];
    assignment: "session-switchback-v1" | null;
    degradedSources: string[];
    items: {
        candidateId: string;
        trackId: string;
        position: number;
        score: number;
        scoreTrace?: ScoredRecommendation["scoreTrace"];
    }[];
    trace?: unknown;
}

/** Engine output and existing evaluator results are isolated for each replay mode. */
export interface FrozenRecommendationReplayReportV1 {
    version: 1;
    nowISO: string;
    sessionId: string;
    runs: {
        id: string;
        mode: RecommendationEngineMode;
        rolloutPercent: number | null;
        served: FrozenReplayGenerationV1;
        shadow: FrozenReplayGenerationV1 | null;
        evaluation: RecommendationShadowEvaluationReport;
    }[];
}

function invalid(reason: string): never {
    throw new TypeError(`Frozen recommendation replay: ${reason}`);
}

function object(
    value: unknown,
    fields: readonly string[],
): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return invalid("expected an object");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return invalid("expected plain JSON data");
    for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(value),
    )) {
        if (
            !fields.includes(key) ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value")
        )
            return invalid("unexpected field or accessor");
    }
    return value as Record<string, unknown>;
}

function list(value: unknown, maximum = 256): unknown[] {
    if (!Array.isArray(value) || value.length > maximum)
        return invalid("array limit exceeded");
    for (let index = 0; index < value.length; index++)
        if (!(index in value))
            return invalid("sparse arrays are not JSON fixtures");
    return value;
}

function number(
    value: unknown,
    minimum: number,
    maximum: number,
    integer = false,
): number {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum ||
        (integer && !Number.isInteger(value))
    )
        return invalid("invalid finite numeric bound");
    return value;
}

function text(value: unknown, pattern: RegExp, maximum: number): string {
    if (
        typeof value !== "string" ||
        value.length > maximum ||
        !pattern.test(value)
    )
        return invalid("invalid synthetic label");
    return value;
}

function id(value: unknown): string {
    return text(value, /^[a-z][a-z0-9-]*$/, 40);
}

function iso(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length !== 24 ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value ||
        value < "2020" ||
        value > "2100"
    )
        return invalid("invalid fixed ISO time");
    return value;
}

function member(value: unknown, allowed: readonly unknown[]): void {
    if (!allowed.includes(value)) return invalid("unsupported enum value");
}

/** Validate every whitelist and bound before creating an engine or repository. */
export function validateFrozenRecommendationReplay(
    raw: unknown,
): FrozenRecommendationReplayV1 {
    const root = object(raw, [
        "version",
        "nowISO",
        "request",
        "candidates",
        "signals",
        "taste",
        "config",
        "observations",
    ]);
    if (root.version !== 1) return invalid("unsupported version");
    const nowISO = iso(root.nowISO);
    const request = object(root.request, [
        "sessionId",
        "intent",
        "limit",
        "perLaneLimit",
        "cursor",
        "exclude",
    ]);
    text(request.sessionId, /^replay-[a-z0-9-]+$/, 64);
    number(request.limit, 0, 75, true);
    if (request.perLaneLimit !== undefined)
        number(request.perLaneLimit, 0, 75, true);
    if (request.cursor !== undefined) number(request.cursor, 0, 10_000, true);
    const intent = object(request.intent, ["surface", "direction", "mood"]);
    member(intent.surface, ["wave", "home", "made-for-you", "similar-tracks"]);
    member(intent.direction, ["for-you", "new", "familiar"]);
    if (intent.mood !== undefined)
        member(intent.mood, [
            null,
            "calm",
            "energetic",
            "focus",
            "workout",
            "favorites",
            "forgotten",
        ]);
    let dimension: number | null = null;
    const vector = (value: unknown) => {
        const values = list(value, 2048);
        if (
            values.length === 0 ||
            (dimension !== null && dimension !== values.length)
        )
            return invalid("inconsistent vector dimensions");
        dimension = values.length;
        values.forEach((coordinate) =>
            number(coordinate, -1_000_000, 1_000_000),
        );
    };
    const candidateIds = new Set<string>();
    for (const item of list(root.candidates)) {
        const candidate = object(item, [
            "id",
            "recordingKey",
            "artist",
            "album",
            "source",
            "providerPrior",
            "accountAffinity",
            "embedding",
            "audioFeatures",
            "lane",
        ]);
        const key = id(candidate.id);
        if (candidateIds.has(key)) return invalid("duplicate candidate ID");
        candidateIds.add(key);
        if (candidate.recordingKey !== undefined) id(candidate.recordingKey);
        text(candidate.artist, /^[\p{L}\p{N} _.,()-]+$/u, 80);
        text(candidate.album, /^[\p{L}\p{N} _.,()-]+$/u, 80);
        member(candidate.source, ["youtube", "library"]);
        number(candidate.providerPrior, -1_000_000, 1_000_000);
        if (candidate.accountAffinity !== undefined)
            number(candidate.accountAffinity, -1_000_000, 1_000_000);
        if (candidate.embedding != null) vector(candidate.embedding);
        if (candidate.audioFeatures !== undefined) {
            const features = object(candidate.audioFeatures, [
                "bpm",
                "energy",
                "arousal",
                "valence",
                "danceability",
                "instrumentalness",
            ]);
            for (const [name, value] of Object.entries(features))
                if (value != null)
                    number(
                        value,
                        name === "bpm" ? 20 : 0,
                        name === "bpm" ? 400 : 1,
                    );
        }
        if (candidate.lane !== undefined)
            member(candidate.lane, ["listenAgain", "quickPicks", "discovery"]);
    }
    const reference = (value: unknown) => {
        const key = id(value);
        if (!candidateIds.has(key))
            return invalid("unknown candidate reference");
        return key;
    };
    const references = (value: unknown) => {
        const values = list(value).map(reference);
        if (new Set(values).size !== values.length)
            return invalid("duplicate candidate reference");
    };
    if (request.exclude !== undefined) references(request.exclude);
    const signals = object(root.signals, [
        "dislikedCandidateIds",
        "unavailableCandidateIds",
        "savedCandidateIds",
        "repeatCandidateIds",
        "hardRepeatCandidateIds",
        "recentExposures",
    ]);
    for (const key of [
        "dislikedCandidateIds",
        "unavailableCandidateIds",
        "savedCandidateIds",
        "repeatCandidateIds",
        "hardRepeatCandidateIds",
    ])
        references(signals[key]);
    for (const row of list(signals.recentExposures)) {
        const exposure = object(row, ["candidateId", "exposedAtISO"]);
        reference(exposure.candidateId);
        if (iso(exposure.exposedAtISO) >= nowISO)
            return invalid("history must precede the frozen request");
    }
    const taste = object(root.taste, [
        "positiveCentroids",
        "negativeCentroids",
        "sessionPositiveEmbedding",
        "sessionNegativeEmbedding",
        "sessionSignalCount",
        "contextCentroids",
        "moodEmbedding",
    ]);
    for (const name of [
        "positiveCentroids",
        "negativeCentroids",
        "contextCentroids",
    ]) {
        if (name !== "contextCentroids" || taste[name] !== undefined)
            list(taste[name], 5).forEach(vector);
    }
    for (const name of [
        "sessionPositiveEmbedding",
        "sessionNegativeEmbedding",
        "moodEmbedding",
    ])
        if (taste[name] != null) vector(taste[name]);
    if (taste.sessionSignalCount !== undefined)
        number(taste.sessionSignalCount, 0, 256, true);
    const config = object(root.config, [
        "rolloutPercents",
        "explorationRate",
        "featureFailure",
        "tasteFailure",
    ]);
    const rollouts = list(config.rolloutPercents, 3);
    if (!rollouts.length || new Set(rollouts).size !== rollouts.length)
        return invalid("invalid rollout cases");
    rollouts.forEach((value) => number(value, 0, 100, true));
    number(config.explorationRate, 0, 0.3);
    for (const name of ["featureFailure", "tasteFailure"])
        if (config[name] !== undefined && typeof config[name] !== "boolean")
            return invalid("invalid fault flag");
    const runIds = new Set([
        "baseline",
        "shadow",
        ...rollouts.map((value) => `active-${value}`),
    ]);
    const observationKeys = new Set<string>();
    for (const item of root.observations === undefined
        ? []
        : list(root.observations)) {
        const observation = object(item, [
            "runId",
            "candidateId",
            "viewed",
            "outcome",
            "listenedSeconds",
            "completionRatio",
        ]);
        member(observation.runId, [...runIds]);
        reference(observation.candidateId);
        if (typeof observation.viewed !== "boolean")
            return invalid("observation requires explicit viewing state");
        if (observation.outcome !== undefined)
            member(observation.outcome, [
                "completed",
                "meaningful",
                "skipped",
                "failed",
            ]);
        if (observation.listenedSeconds !== undefined)
            number(observation.listenedSeconds, 0, 3600);
        if (observation.completionRatio !== undefined)
            number(observation.completionRatio, 0, 1);
        if (
            !observation.viewed &&
            (observation.outcome !== undefined ||
                observation.listenedSeconds !== undefined ||
                observation.completionRatio !== undefined)
        )
            return invalid(
                "playback observation requires a viewed served item",
            );
        const key = `${observation.runId}:${observation.candidateId}`;
        if (observationKeys.has(key)) return invalid("duplicate observation");
        observationKeys.add(key);
    }
    const encoded = JSON.stringify(root);
    if (
        Buffer.byteLength(encoded, "utf8") >
        MAX_FROZEN_RECOMMENDATION_REPLAY_BYTES
    )
        return invalid("fixture byte limit exceeded");
    return JSON.parse(encoded) as FrozenRecommendationReplayV1;
}

function trackId(candidate: FrozenReplayCandidateV1): string {
    return `${candidate.source === "youtube" ? "yt" : "library"}:${candidate.id}`;
}

function canonicalKey(candidate: FrozenReplayCandidateV1): string {
    return `replay-recording:${candidate.recordingKey ?? candidate.id}`;
}

function sourceCandidate(
    candidate: FrozenReplayCandidateV1,
): RecommendationCandidate {
    return {
        id: trackId(candidate),
        canonicalKey: `replay-source:${candidate.source}:${candidate.id}`,
        title: `Synthetic ${candidate.id}`,
        duration: 180,
        artist: { id: null, name: candidate.artist },
        album: { id: null, title: candidate.album, coverArt: null },
        source: candidate.source,
        streamSource: candidate.source,
        provider: {
            youtubeVideoId:
                candidate.source === "youtube" ? candidate.id : null,
            tidalTrackId: null,
        },
        candidateSources: ["frozen-replay"],
        providerPrior: candidate.providerPrior,
        ...(candidate.lane ? { lane: candidate.lane } : {}),
    };
}

/**
 * Execute the actual DI engine and existing evaluator using only validated memory.
 * Each mode has its own generation collector and evaluator repository. Shadow rows
 * never receive observations; an emitted exposure alone is neither viewed nor played.
 */
export async function runFrozenRecommendationReplay(
    raw: unknown,
    options: { traceEnabled?: boolean } = {},
): Promise<FrozenRecommendationReplayReportV1> {
    const fixture = validateFrozenRecommendationReplay(raw);
    // Validate first: unsupported schemas cannot load production implementation seams.
    const [
        { RecommendationEngine },
        { RecommendationShadowEvaluationService },
        { orderWaveRecommendations },
    ] = await Promise.all([
        import("./engine"),
        import("./shadowEvaluation"),
        import("./orderedWave"),
    ]);
    const byId = new Map(
        fixture.candidates.map((candidate) => [candidate.id, candidate]),
    );
    const byTrackId = new Map(
        fixture.candidates.map((candidate) => [trackId(candidate), candidate]),
    );
    const keySet = (ids: readonly string[]) =>
        new Set(ids.map((value) => canonicalKey(byId.get(value)!)));
    const repeatKeys = (ids: readonly string[]) =>
        new Set(
            ids.flatMap((value) => [
                trackId(byId.get(value)!),
                canonicalKey(byId.get(value)!),
            ]),
        );
    const now = new Date(fixture.nowISO);
    const request: RecommendRequest = {
        ...fixture.request,
        intent: { ...fixture.request.intent },
        userId: "replay-owner",
        ...(fixture.request.exclude
            ? {
                  exclude: fixture.request.exclude.map((value) =>
                      trackId(byId.get(value)!),
                  ),
              }
            : {}),
    };
    const cases = [
        { id: "baseline", mode: "baseline" as const, rolloutPercent: null },
        { id: "shadow", mode: "shadow" as const, rolloutPercent: null },
        ...fixture.config.rolloutPercents.map((rolloutPercent) => ({
            id: `active-${rolloutPercent}`,
            mode: "active" as const,
            rolloutPercent,
        })),
    ];
    const runs: FrozenRecommendationReplayReportV1["runs"] = [];
    for (const replayCase of cases) {
        const writes: { id: string; input: RecordEngineGenerationInput }[] = [];
        const observations = (fixture.observations ?? []).filter(
            (row) => row.runId === replayCase.id,
        );
        const dependencies: RecommendationEngineDependencies = {
            mode: replayCase.mode,
            hybridRolloutPercent: replayCase.rolloutPercent ?? 100,
            explorationRate: fixture.config.explorationRate,
            traceEnabled: options.traceEnabled === true,
            finalizeWaveRecommendations: (rows) =>
                orderWaveRecommendations(rows),
            loadCandidates: async () => ({
                candidates: fixture.candidates.map(sourceCandidate),
                nextCursor: (request.cursor ?? 0) + 1,
                degradedSources: [],
            }),
            resolveCanonical: async (candidate) => {
                const descriptor = byTrackId.get(candidate.id)!;
                return {
                    id: `replay-canonical:${descriptor.recordingKey ?? descriptor.id}`,
                    canonicalKey: canonicalKey(descriptor),
                    verifiedCanonicalKey: canonicalKey(descriptor),
                };
            },
            enrichCandidates: async (candidates) => {
                if (fixture.config.featureFailure)
                    throw new Error("Synthetic optional feature failure");
                return candidates.map((candidate) => {
                    const descriptor = byTrackId.get(candidate.id)!;
                    return {
                        ...candidate,
                        ...(descriptor.accountAffinity !== undefined
                            ? { accountAffinity: descriptor.accountAffinity }
                            : {}),
                        ...(descriptor.embedding !== undefined
                            ? {
                                  embedding:
                                      descriptor.embedding === null
                                          ? null
                                          : [...descriptor.embedding],
                              }
                            : {}),
                        ...(descriptor.audioFeatures
                            ? { audioFeatures: { ...descriptor.audioFeatures } }
                            : {}),
                    };
                });
            },
            loadRecentExposures: async () =>
                fixture.signals.recentExposures.map((exposure) => {
                    const descriptor = byId.get(exposure.candidateId)!;
                    return {
                        canonicalKey: canonicalKey(descriptor),
                        artistKey: normalizeRecommendationArtistKey(
                            descriptor.artist,
                        ),
                        albumKey: buildRecommendationAlbumKey(
                            descriptor.artist,
                            descriptor.album,
                        ),
                        exposedAt: new Date(exposure.exposedAtISO),
                    };
                }),
            loadDislikedCanonicalKeys: async () =>
                keySet(fixture.signals.dislikedCandidateIds),
            loadDislikeAdmission: async (_userId, candidates) => ({
                dislikedKeys: keySet(fixture.signals.dislikedCandidateIds),
                unavailableCanonicalKeys: keySet(
                    fixture.signals.unavailableCandidateIds,
                ),
                verifiedCanonicalKeys: new Map(
                    candidates.map((candidate) => [
                        `${candidate.source}:${candidate.id}`,
                        canonicalKey(byTrackId.get(candidate.id)!),
                    ]),
                ),
                diagnostics: {
                    requestedGroups: candidates.length,
                    unavailableGroups:
                        fixture.signals.unavailableCandidateIds.length,
                    verifiedAliasReferences: candidates.length,
                    unresolvedReferences: 0,
                },
            }),
            loadSavedCanonicalKeys: async () =>
                keySet(fixture.signals.savedCandidateIds),
            loadVerifiedRepeatExclusions: async () => ({
                ids: repeatKeys(fixture.signals.repeatCandidateIds),
                hardIds: repeatKeys(fixture.signals.hardRepeatCandidateIds),
            }),
            loadTasteContext: async () => {
                if (fixture.config.tasteFailure)
                    throw new Error("Synthetic optional taste failure");
                return structuredClone(fixture.taste);
            },
            recordGeneration: async (input) => {
                const generationId = `replay:${replayCase.id}:${input.served ? "served" : "shadow"}`;
                writes.push({ id: generationId, input });
                return generationId;
            },
            scheduleHotSet: async () => {},
            now: () => new Date(now),
        };
        const result = await new RecommendationEngine(dependencies, {
            recordGeneration: () => {},
        }).recommend({ ...request });
        // Every replay persistence callback completes in memory, including the supervised pair.
        await Promise.resolve();
        const served = writes.find(({ input }) => input.served);
        const shadow = writes.find(({ input }) => !input.served);
        if (
            !served ||
            writes.length !==
                (replayCase.mode === "shadow" ||
                (replayCase.mode === "active" &&
                    replayCase.rolloutPercent! < 100)
                    ? 2
                    : 1) ||
            served.id !== result.generationId ||
            served.input.recommendations.length !== result.tracks.length ||
            served.input.recommendations.some(
                ({ track }, index) => track.id !== result.tracks[index]?.id,
            )
        )
            return invalid("engine generation collection is incomplete");
        if (
            observations.some(
                (observation) =>
                    !served.input.recommendations.some(
                        ({ track }) =>
                            byTrackId.get(track.id)?.id ===
                            observation.candidateId,
                    ),
            )
        )
            return invalid("observation target was not served");
        const generation = ({
            id,
            input,
        }: (typeof writes)[number]): FrozenReplayGenerationV1 => ({
            id,
            algorithm: input.algorithm,
            assignment:
                input.context?.experimentAssignment === "session-switchback-v1"
                    ? "session-switchback-v1"
                    : null,
            degradedSources: [...input.degradedSources],
            items: input.recommendations.map(
                ({ track, score, scoreTrace }, position) => ({
                    candidateId: byTrackId.get(track.id)!.id,
                    trackId: track.id,
                    position,
                    score,
                    ...(scoreTrace ? { scoreTrace } : {}),
                }),
            ),
            ...(input.context?.recommendationTrace
                ? { trace: input.context.recommendationTrace }
                : {}),
        });
        const samples: RecommendationEvaluationGenerationSample[] = writes.map(
            ({ id, input }) => ({
                id,
                userId: request.userId,
                sessionId: request.sessionId,
                surface: input.surface,
                direction: input.direction,
                mood: input.mood,
                cursor: input.cursor,
                algorithm: input.algorithm,
                served: input.served,
                latencyMs: input.latencyMs,
                createdAt: new Date(now),
                context: input.context,
                exposures: input.recommendations.map(({ track }) => {
                    const observation = input.served
                        ? observations.find(
                              (row) =>
                                  row.candidateId ===
                                  byTrackId.get(track.id)!.id,
                          )
                        : undefined;
                    return {
                        canonicalKey: track.canonicalKey,
                        artistKey: normalizeRecommendationArtistKey(
                            track.artist.name,
                        ),
                        exposedAt: new Date(now),
                        viewedAt: observation?.viewed ? new Date(now) : null,
                        playedAt:
                            observation &&
                            (observation.outcome !== undefined ||
                                observation.listenedSeconds !== undefined ||
                                observation.completionRatio !== undefined)
                                ? new Date(now)
                                : null,
                        outcome: observation?.outcome ?? null,
                        listenedSeconds: observation?.listenedSeconds ?? null,
                        completionRatio: observation?.completionRatio ?? null,
                    };
                }),
            }),
        );
        // The same explicitly viewed frozen history supplies the engine and evaluator.
        for (const [
            index,
            exposure,
        ] of fixture.signals.recentExposures.entries()) {
            const descriptor = byId.get(exposure.candidateId)!;
            const exposedAt = new Date(exposure.exposedAtISO);
            samples.push({
                id: `replay:${replayCase.id}:history:${index}`,
                userId: request.userId,
                sessionId: `replay-history-${index}`,
                surface: request.intent.surface,
                direction: request.intent.direction,
                mood: request.intent.mood ?? null,
                cursor: 0,
                algorithm: "baseline-v1",
                served: true,
                latencyMs: 0,
                createdAt: exposedAt,
                exposures: [
                    {
                        canonicalKey: canonicalKey(descriptor),
                        artistKey: normalizeRecommendationArtistKey(
                            descriptor.artist,
                        ),
                        exposedAt,
                        viewedAt: exposedAt,
                        playedAt: null,
                        outcome: null,
                        listenedSeconds: null,
                        completionRatio: null,
                    },
                ],
            });
        }
        const evaluation = await new RecommendationShadowEvaluationService({
            loadGenerations: async (since, until) =>
                samples.filter(
                    (sample) =>
                        sample.createdAt >= since && sample.createdAt < until,
                ),
        }).evaluate({
            since: new Date(now),
            until: new Date(now.getTime() + 1),
        });
        runs.push({
            ...replayCase,
            served: generation(served),
            shadow: shadow ? generation(shadow) : null,
            evaluation,
        });
    }
    return {
        version: 1,
        nowISO: fixture.nowISO,
        sessionId: fixture.request.sessionId,
        runs,
    };
}
