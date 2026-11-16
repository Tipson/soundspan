import { randomUUID } from "node:crypto";
import type {
    PersonalizedCatalogOptions,
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "../personalizedCatalog";
import { buildCanonicalRecordingKey } from "./canonicalIdentity";
import {
    hasNativeRecommendationIdentity,
    readNativeRecommendationRecording,
    toNativeRecommendationCandidate,
} from "./nativeCandidates";
import {
    matchesWaveLanguage,
    type LanguageRecording,
    type WaveLanguage,
} from "./recordingLanguage";
import type { PreparedRecordingLanguages } from "./recordingLanguageStore";
import type { SavedMoodCandidateOptions } from "./featureStore";
import {
    createRadioRequestExecution,
    type RadioRequestExecution,
} from "./radioRequestExecution";
import {
    toRadioContinuationTrack,
    type RadioContinuationInput,
    type RadioContinuationResponse,
    type RadioContinuationTrack,
} from "./radioContinuation";
import { orderWaveRecommendations } from "./orderedWave";
import {
    createWaveSequenceContext,
    encodeWaveSequenceCursor,
    parseWaveSequenceCursor,
    validateWaveSequenceContinuation,
    WaveSequenceError,
    type WaveSequenceReference,
    type WaveSequenceIntent,
    type WaveSequenceContextV1,
} from "./waveSequence";
import {
    RecommendationEngine,
    type RecommendationCandidateBatch,
    type RecommendationEngineDependencies,
} from "./engine";
import type {
    RecommendRequest,
    RecommendResult,
    RecommendationCandidate,
    RecommendationMood,
    RecommendationRequestContext,
    RecommendationSurface,
} from "./types";

const MAX_PERSONALIZED_SOURCE_SHELF_LIMIT = 25;
const PERSONALIZED_CANDIDATE_RESERVE_MULTIPLIER = 3;

type CommonEngineDependencies = Omit<
    RecommendationEngineDependencies,
    "loadCandidates"
>;

export interface UnifiedRecommendationDependencies extends CommonEngineDependencies {
    /** Independent opt-in capability; disabled clients retain the legacy shelf path. */
    waveSequenceEnabled?: boolean;
    /** One exact owned generation lookup, before any continuation candidate work. */
    loadWaveSequenceGeneration?: (
        generationId: string,
        userId: string,
        sessionId: string,
    ) => Promise<
        | Parameters<typeof validateWaveSequenceContinuation>[0]["generation"]
        | null
    >;
    /** Original-station candidate selection with account exclusions before local quotas. */
    loadRadioCandidates?: (
        input: RadioContinuationInput,
        policyTime: Date,
    ) => Promise<RecommendationCandidateBatch>;
    /** Bounded personal, already-analyzed reserve for explicit listening moods. */
    loadSavedMoodCandidates?: (
        userId: string,
        mood: RecommendationMood,
        options?: SavedMoodCandidateOptions,
    ) => Promise<RecommendationCandidate[]>;
    prepareLanguages?: (
        tracks: LanguageRecording[],
    ) => Promise<PreparedRecordingLanguages>;
    loadPersonalizedFeed: (
        userId: string,
        limit: number,
        options: PersonalizedCatalogOptions,
    ) => Promise<PersonalizedHomeFeed>;
    loadSimilarCandidates: (
        request: RecommendRequest,
    ) => Promise<RecommendationCandidateBatch>;
}

export interface PersonalizedRecommendationInput {
    userId: string;
    sessionId: string;
    surface: Exclude<RecommendationSurface, "similar-tracks">;
    limit: number;
    cursor: number;
    direction: "for-you" | "new" | "familiar";
    mood: RecommendationMood | null;
    timeOfDay?: boolean;
    language?: WaveLanguage;
    excludeVideoIds: string[];
    context?: RecommendationRequestContext;
    /** Authenticated playback probe: compute normally without user-signal writes. */
    diagnostic?: boolean;
    /** Explicit capability, never inferred from the Wave surface. */
    waveSequenceVersion?: 1;
    waveSequenceCursor?: string;
    waveSequenceTail?: unknown;
}

/** Public finite order, without server-only artist identity or ranking features. */
export interface OrderedWaveFeedV1 {
    version: 1;
    sequenceId: string;
    startPosition: number;
    items: {
        position: number;
        track: Omit<RadioContinuationTrack, "streamSource" | "album"> & {
            streamSource: RecommendationCandidate["source"];
            album: RadioContinuationTrack["album"] & {
                artist: RadioContinuationTrack["artist"];
            };
        };
    }[];
    nextCursor: string;
    tail: WaveSequenceReference[];
}

export type PersonalizedRecommendationFeed = PersonalizedHomeFeed & {
    orderedWave?: OrderedWaveFeedV1;
    languageStatus?: {
        selection: WaveLanguage;
        pending: boolean;
        classified: number;
        total: number;
    };
    generationId: string;
    degradedSources: string[];
};

function personalizedCandidate(
    track: PersonalizedTrack,
    lane: NonNullable<RecommendationCandidate["lane"]>,
): RecommendationCandidate | null {
    const providerPrior =
        lane === "listenAgain" ? 1.3 : lane === "quickPicks" ? 1.15 : 1;
    const accountAffinity =
        lane === "listenAgain" ? 0.8 : lane === "quickPicks" ? 0.55 : 0;
    const candidate: RecommendationCandidate = {
        id: track.id,
        canonicalKey: "",
        title: track.title,
        duration: track.duration,
        trackNo: track.trackNo,
        artist: track.artist,
        album: {
            id: track.album.id,
            title: track.album.title,
            coverArt: track.album.coverArt,
        },
        source: track.source,
        provider: track.provider,
        streamSource: track.streamSource,
        youtubeVideoId: track.youtubeVideoId,
        ...(track.source === "vk" || track.source === "yandex"
            ? { musicSourceRecording: track.musicSourceRecording }
            : {}),
        candidateSources: [`personalized-${lane}`],
        providerPrior,
        accountAffinity,
        lane,
    };
    if (hasNativeRecommendationIdentity(candidate)) {
        const recording = readNativeRecommendationRecording(candidate);
        if (!recording) return null;
        return {
            ...toNativeRecommendationCandidate(
                recording,
                `personalized-${lane}`,
            )!,
            lane,
            providerPrior,
            accountAffinity,
        };
    }
    candidate.canonicalKey = buildCanonicalRecordingKey(candidate);
    return candidate;
}

function flattenPersonalizedFeed(
    feed: PersonalizedHomeFeed,
): RecommendationCandidate[] {
    return [
        ...feed.shelves.listenAgain.flatMap(
            (track) => personalizedCandidate(track, "listenAgain") ?? [],
        ),
        ...feed.shelves.quickPicks.flatMap(
            (track) => personalizedCandidate(track, "quickPicks") ?? [],
        ),
        ...feed.shelves.discovery.flatMap(
            (track) => personalizedCandidate(track, "discovery") ?? [],
        ),
    ];
}

function personalizedSourceShelfLimit(visibleShelfLimit: number): number {
    return Math.min(
        MAX_PERSONALIZED_SOURCE_SHELF_LIMIT,
        Math.max(
            visibleShelfLimit,
            visibleShelfLimit * PERSONALIZED_CANDIDATE_RESERVE_MULTIPLIER,
        ),
    );
}

function toPersonalizedTrack(
    candidate: RecommendationCandidate,
): PersonalizedTrack | null {
    if (hasNativeRecommendationIdentity(candidate)) {
        const recording = readNativeRecommendationRecording(candidate);
        if (!recording) return null;
        const safe = toNativeRecommendationCandidate(
            recording,
            "personalized-public",
        )!;
        return {
            id: safe.id,
            title: safe.title,
            duration: safe.duration,
            trackNo: null,
            artist: safe.artist,
            album: { id: null, title: "", coverArt: "", artist: safe.artist },
            source: recording.provider,
            streamSource: recording.provider,
            musicSourceRecording: recording,
            provider: {
                source: recording.provider,
                providerTrackId: recording.id,
                tidalTrackId: null,
                youtubeVideoId: null,
            },
        };
    }
    const videoId = candidate.provider.youtubeVideoId;
    if (!videoId) return null;
    const coverArt =
        candidate.album.coverArt ??
        `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
    return {
        id: `yt:${videoId}`,
        title: candidate.title,
        duration: candidate.duration,
        trackNo: null,
        artist: candidate.artist,
        album: {
            id: candidate.album.id,
            title: candidate.album.title,
            coverArt,
            artist: candidate.artist,
        },
        source: "youtube",
        streamSource: "youtube",
        youtubeVideoId: videoId,
        provider: { tidalTrackId: null, youtubeVideoId: videoId },
    };
}

function toOrderedWaveTrack(
    candidate: RecommendationCandidate,
): OrderedWaveFeedV1["items"][number]["track"] {
    const safe = toRadioContinuationTrack(candidate);
    return {
        ...safe,
        streamSource: candidate.source,
        album: { ...safe.album, artist: safe.artist },
    };
}

/** Compatibility facade; every product surface crosses one engine boundary. */
export class UnifiedRecommendationService {
    constructor(
        private readonly dependencies: UnifiedRecommendationDependencies,
    ) {}

    private engine(
        loadCandidates: RecommendationEngineDependencies["loadCandidates"],
        diagnostic = false,
        execution?: RadioRequestExecution,
        finalizeWaveRecommendations?: RecommendationEngineDependencies["finalizeWaveRecommendations"],
    ): RecommendationEngine {
        const sourceDependencies = {
            ...this.dependencies,
            loadCandidates,
            ...(finalizeWaveRecommendations
                ? { finalizeWaveRecommendations }
                : {}),
        };
        const guard =
            <Args extends unknown[], Result>(
                operation: (...args: Args) => Promise<Result>,
            ) =>
            (...args: Args) =>
                execution!.run(() => operation(...args));
        const dependencies = execution
            ? {
                  ...sourceDependencies,
                  loadCandidates: guard(sourceDependencies.loadCandidates),
                  resolveCanonical: guard(sourceDependencies.resolveCanonical),
                  ...(sourceDependencies.loadCanonicalMappings
                      ? {
                            loadCanonicalMappings: guard(
                                sourceDependencies.loadCanonicalMappings,
                            ),
                        }
                      : {}),
                  ...(sourceDependencies.enrichCandidates
                      ? {
                            enrichCandidates: guard(
                                sourceDependencies.enrichCandidates,
                            ),
                        }
                      : {}),
                  loadRecentExposures: guard(
                      sourceDependencies.loadRecentExposures,
                  ),
                  loadDislikedCanonicalKeys: guard(
                      sourceDependencies.loadDislikedCanonicalKeys,
                  ),
                  ...(sourceDependencies.loadDislikeAdmission
                      ? {
                            loadDislikeAdmission: (
                                userId: string,
                                candidates: readonly RecommendationCandidate[],
                            ) =>
                                execution.run(() =>
                                    sourceDependencies.loadDislikeAdmission!(
                                        userId,
                                        candidates,
                                        execution.check,
                                    ),
                                ),
                        }
                      : {}),
                  ...(sourceDependencies.loadVerifiedRepeatExclusions
                      ? {
                            loadVerifiedRepeatExclusions: (
                                userId: string,
                                now: Date,
                            ) =>
                                execution.run(() =>
                                    sourceDependencies.loadVerifiedRepeatExclusions!(
                                        userId,
                                        now,
                                        execution.check,
                                    ),
                                ),
                        }
                      : {}),
                  ...(sourceDependencies.loadSavedCanonicalKeys
                      ? {
                            loadSavedCanonicalKeys: guard(
                                sourceDependencies.loadSavedCanonicalKeys,
                            ),
                        }
                      : {}),
                  loadTasteContext: guard(sourceDependencies.loadTasteContext),
                  recordGeneration: (
                      input: Parameters<
                          CommonEngineDependencies["recordGeneration"]
                      >[0],
                  ) =>
                      execution.run(() =>
                          sourceDependencies.recordGeneration({
                              ...input,
                              execution,
                          }),
                      ),
                  scheduleHotSet: guard(sourceDependencies.scheduleHotSet),
              }
            : sourceDependencies;
        if (!diagnostic) return new RecommendationEngine(dependencies);
        return new RecommendationEngine(
            {
                ...dependencies,
                recordGeneration: async () => "diagnostic-recommendation",
                scheduleHotSet: async () => {},
            },
            { recordGeneration: () => {} },
        );
    }

    async getPersonalizedFeed(
        input: PersonalizedRecommendationInput,
        options?: { signal?: AbortSignal },
    ): Promise<PersonalizedRecommendationFeed> {
        const execution = createRadioRequestExecution(options?.signal);
        try {
            const sequenced = input.waveSequenceVersion === 1;
            if (
                (input.waveSequenceVersion !== undefined && !sequenced) ||
                (!sequenced &&
                    (input.waveSequenceCursor !== undefined ||
                        input.waveSequenceTail !== undefined)) ||
                (sequenced &&
                    (!this.dependencies.waveSequenceEnabled ||
                        input.surface !== "wave" ||
                        input.diagnostic ||
                        !input.sessionId ||
                        !Number.isInteger(input.limit) ||
                        input.limit < 1 ||
                        input.limit > 25))
            )
                throw new WaveSequenceError("invalid_cursor");
            const sequenceIntent: WaveSequenceIntent = {
                direction: input.direction,
                mood: input.mood,
                language: input.language ?? "any",
            };
            let previous: WaveSequenceContextV1 | undefined;
            if (sequenced && input.waveSequenceCursor !== undefined) {
                const cursor = parseWaveSequenceCursor(
                    input.waveSequenceCursor,
                    execution.check,
                );
                const load = this.dependencies.loadWaveSequenceGeneration;
                if (!load) throw new WaveSequenceError("invalid_cursor");
                const generation = await execution.run(() =>
                    load(cursor.generationId, input.userId, input.sessionId),
                );
                if (!generation) throw new WaveSequenceError("invalid_cursor");
                previous = validateWaveSequenceContinuation({
                    cursor,
                    tail: input.waveSequenceTail,
                    generation,
                    userId: input.userId,
                    sessionId: input.sessionId,
                    intent: sequenceIntent,
                    now: this.dependencies.now(),
                    check: execution.check,
                });
            } else if (
                sequenced &&
                (input.waveSequenceTail !== undefined || input.cursor !== 0)
            ) {
                throw new WaveSequenceError("invalid_tail");
            }
            const sourceCursor = previous?.nextSourceCursor ?? input.cursor;
            const startPosition = previous?.nextPosition ?? 0;
            const sequenceId = sequenced
                ? (previous?.sequenceId ?? randomUUID())
                : undefined;
            const sourceState: { feed?: PersonalizedHomeFeed } = {};
            let languageStatus: PersonalizedRecommendationFeed["languageStatus"];
            const engine = this.engine(
                async (_request, policyTime) => {
                    const sourceFeed =
                        await this.dependencies.loadPersonalizedFeed(
                            input.userId,
                            personalizedSourceShelfLimit(input.limit),
                            {
                                execution,
                                ...(options?.signal
                                    ? { sourceSignal: options.signal }
                                    : {}),
                                cursor: sourceCursor,
                                mode: input.direction,
                                surface: input.surface,
                                ...(input.mood ? { mood: input.mood } : {}),
                                ...(input.timeOfDay &&
                                input.context?.localHour !== undefined &&
                                input.context.timezoneOffsetMinutes !==
                                    undefined
                                    ? {
                                          listeningContext: {
                                              localHour:
                                                  input.context.localHour,
                                              timezoneOffsetMinutes:
                                                  input.context
                                                      .timezoneOffsetMinutes,
                                          },
                                      }
                                    : {}),
                                ...(input.excludeVideoIds.length > 0
                                    ? { excludeVideoIds: input.excludeVideoIds }
                                    : {}),
                            },
                        );
                    sourceState.feed = sourceFeed;
                    let candidates = flattenPersonalizedFeed(sourceFeed);
                    const reserveDegraded: string[] = [];
                    if (
                        input.surface === "wave" &&
                        input.direction !== "new" &&
                        input.mood &&
                        ["calm", "energetic", "focus", "workout"].includes(
                            input.mood,
                        ) &&
                        this.dependencies.loadSavedMoodCandidates
                    ) {
                        try {
                            const saved = await execution.run(() =>
                                this.dependencies.loadSavedMoodCandidates!(
                                    input.userId,
                                    input.mood!,
                                    {
                                        allowRecentListeningFallback:
                                            Object.values(
                                                sourceFeed.shelves,
                                            ).every(
                                                (tracks) => tracks.length === 0,
                                            ),
                                        now: policyTime,
                                        execution,
                                        excludeVideoIds: input.excludeVideoIds,
                                    },
                                ),
                            );
                            candidates.push(
                                ...saved.map((candidate) => ({
                                    ...candidate,
                                    lane:
                                        input.direction === "familiar"
                                            ? ("listenAgain" as const)
                                            : ("quickPicks" as const),
                                })),
                            );
                        } catch {
                            execution.check();
                            reserveDegraded.push("saved-mood-candidates");
                        }
                    }
                    if (input.surface === "wave") {
                        const selection = input.language ?? "any";
                        const prepared = this.dependencies.prepareLanguages
                            ? await execution.run(() =>
                                  this.dependencies.prepareLanguages!(
                                      candidates,
                                  ),
                              )
                            : {
                                  languages: candidates.map(() => null),
                                  pending: false,
                              };
                        languageStatus = {
                            selection,
                            pending: prepared.pending,
                            classified: prepared.languages.filter(
                                (value) =>
                                    value === "ru" || value === "foreign",
                            ).length,
                            total: candidates.length,
                        };
                        candidates = candidates.filter((_candidate, index) =>
                            matchesWaveLanguage(
                                prepared.languages[index] ?? null,
                                selection,
                            ),
                        );
                    }
                    return {
                        candidates,
                        nextCursor: sourceFeed.nextCursor,
                        degradedSources: [
                            ...reserveDegraded,
                            ...((sourceFeed.degradedSources?.length ?? 0) > 0
                                ? (sourceFeed.degradedSources ?? [])
                                : sourceFeed.degraded && sourceFeed.reason
                                  ? [sourceFeed.reason]
                                  : []),
                        ],
                    };
                },
                input.diagnostic,
                execution,
                sequenced
                    ? (admitted) => {
                          const ordered = orderWaveRecommendations(
                              admitted,
                              previous?.tail.map((row) => row.artistKey),
                              execution.check,
                          );
                          // Public serialization must succeed before the only served write.
                          for (const { track } of ordered)
                              toOrderedWaveTrack(track);
                          const orderedWave = createWaveSequenceContext({
                              ordered,
                              sequenceId: sequenceId!,
                              startPosition,
                              nextSourceCursor: sourceState.feed!.nextCursor,
                              verifiedPreviousTail: previous?.tail ?? [],
                              intent: sequenceIntent,
                              check: execution.check,
                          });
                          return { recommendations: ordered, orderedWave };
                      }
                    : undefined,
            );
            const result = await execution.run(() =>
                engine.recommend({
                    userId: input.userId,
                    ...(input.timeOfDay ? { timeOfDay: true } : {}),
                    intent: {
                        surface: input.surface,
                        direction: input.direction,
                        mood: input.mood,
                        language: input.language,
                    },
                    sessionId: input.sessionId,
                    cursor: sourceCursor,
                    limit: sequenced ? input.limit : input.limit * 3,
                    ...(sequenced ? {} : { perLaneLimit: input.limit }),
                    exclude: input.excludeVideoIds,
                    context: input.context,
                }),
            );
            const shelves: PersonalizedHomeFeed["shelves"] = {
                listenAgain: [],
                quickPicks: [],
                discovery: [],
            };
            for (const candidate of result.tracks) {
                const track = toPersonalizedTrack(candidate);
                if (!track) continue;
                const lane = candidate.lane ?? "discovery";
                if (shelves[lane].length < input.limit) {
                    shelves[lane].push(track);
                }
            }
            const baseline = sourceState.feed;
            execution.check();
            return {
                shelves,
                degraded:
                    Boolean(baseline?.degraded) ||
                    result.degradedSources.length > 0,
                reason:
                    baseline?.reason ??
                    (result.degradedSources.length > 0
                        ? "provider_partial_failure"
                        : null),
                seedCount: baseline?.seedCount ?? 0,
                nextCursor: result.nextCursor,
                generationId: result.generationId,
                degradedSources: result.degradedSources,
                ...(result.orderedWave
                    ? {
                          orderedWave: {
                              version: 1 as const,
                              sequenceId: result.orderedWave.sequenceId,
                              startPosition,
                              items: result.tracks.map((track, index) => ({
                                  position: startPosition + index,
                                  track: toOrderedWaveTrack(track),
                              })),
                              nextCursor: encodeWaveSequenceCursor(
                                  result.generationId,
                                  result.orderedWave,
                                  execution.check,
                              ),
                              tail: result.orderedWave.tail.map(
                                  ({ source, id, position }) => ({
                                      source,
                                      id,
                                      position,
                                  }),
                              ),
                          },
                      }
                    : {}),
                ...(languageStatus ? { languageStatus } : {}),
            };
        } finally {
            execution.dispose();
        }
    }

    recommendSimilar(request: RecommendRequest): Promise<RecommendResult> {
        return this.engine(this.dependencies.loadSimilarCandidates).recommend(
            request,
        );
    }

    /** Continue the original station through the same ranking and served-membership boundary. */
    async recommendRadio(
        input: RadioContinuationInput,
        options?: { signal?: AbortSignal },
    ): Promise<RadioContinuationResponse> {
        const loader = this.dependencies.loadRadioCandidates;
        if (!loader)
            throw new Error("Radio continuation loader is unavailable");
        const execution = createRadioRequestExecution(options?.signal);
        try {
            const result = await execution.run(() =>
                this.engine(
                    (_request, policyTime) =>
                        loader(
                            {
                                ...input,
                                execution,
                                ...(options?.signal
                                    ? { sourceSignal: options.signal }
                                    : {}),
                            },
                            policyTime,
                        ),
                    input.diagnostic,
                    execution,
                ).recommend({
                    userId: input.userId,
                    sessionId: input.sessionId,
                    intent: {
                        surface: "wave",
                        direction: "for-you",
                        mood: null,
                        language: "any",
                    },
                    cursor: input.cursor,
                    limit: input.limit,
                    exclude: input.exclude,
                }),
            );
            return {
                tracks: result.tracks.map(toRadioContinuationTrack),
                radioOrigin: input.radioOrigin,
                generationId: result.generationId,
                nextCursor: result.nextCursor,
                degraded: result.degradedSources.length > 0,
                degradedSources: result.degradedSources,
            };
        } finally {
            execution.dispose();
        }
    }
}
