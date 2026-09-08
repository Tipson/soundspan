import type {
    PersonalizedCatalogOptions,
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "../personalizedCatalog";
import { buildCanonicalRecordingKey } from "./canonicalIdentity";
import {
    matchesWaveLanguage,
    type LanguageRecording,
    type WaveLanguage,
} from "./recordingLanguage";
import type { PreparedRecordingLanguages } from "./recordingLanguageStore";
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
    /** Bounded personal, already-analyzed reserve for explicit listening moods. */
    loadSavedMoodCandidates?: (
        userId: string,
        mood: RecommendationMood,
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
    language?: WaveLanguage;
    excludeVideoIds: string[];
    context?: RecommendationRequestContext;
    /** Authenticated playback probe: compute normally without user-signal writes. */
    diagnostic?: boolean;
}

export type PersonalizedRecommendationFeed = PersonalizedHomeFeed & {
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
): RecommendationCandidate {
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
        source: "youtube",
        provider: track.provider,
        streamSource: "youtube",
        youtubeVideoId: track.youtubeVideoId,
        candidateSources: [`personalized-${lane}`],
        providerPrior,
        accountAffinity,
        lane,
    };
    candidate.canonicalKey = buildCanonicalRecordingKey(candidate);
    return candidate;
}

function flattenPersonalizedFeed(
    feed: PersonalizedHomeFeed,
): RecommendationCandidate[] {
    return [
        ...feed.shelves.listenAgain.map((track) =>
            personalizedCandidate(track, "listenAgain"),
        ),
        ...feed.shelves.quickPicks.map((track) =>
            personalizedCandidate(track, "quickPicks"),
        ),
        ...feed.shelves.discovery.map((track) =>
            personalizedCandidate(track, "discovery"),
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

/** Compatibility facade; every product surface crosses one engine boundary. */
export class UnifiedRecommendationService {
    constructor(
        private readonly dependencies: UnifiedRecommendationDependencies,
    ) {}

    private engine(
        loadCandidates: RecommendationEngineDependencies["loadCandidates"],
        diagnostic = false,
    ): RecommendationEngine {
        const dependencies = {
            ...this.dependencies,
            loadCandidates,
        };
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
    ): Promise<PersonalizedRecommendationFeed> {
        const sourceState: { feed?: PersonalizedHomeFeed } = {};
        let languageStatus: PersonalizedRecommendationFeed["languageStatus"];
        const engine = this.engine(async () => {
            const sourceFeed = await this.dependencies.loadPersonalizedFeed(
                input.userId,
                personalizedSourceShelfLimit(input.limit),
                {
                    cursor: input.cursor,
                    mode: input.direction,
                    surface: input.surface,
                    ...(input.mood ? { mood: input.mood } : {}),
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
                    const saved =
                        await this.dependencies.loadSavedMoodCandidates(
                            input.userId,
                            input.mood,
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
                    reserveDegraded.push("saved-mood-candidates");
                }
            }
            if (input.surface === "wave") {
                const selection = input.language ?? "any";
                const prepared = this.dependencies.prepareLanguages
                    ? await this.dependencies.prepareLanguages(candidates)
                    : { languages: candidates.map(() => null), pending: false };
                languageStatus = {
                    selection,
                    pending: prepared.pending,
                    classified: prepared.languages.filter(
                        (value) => value === "ru" || value === "foreign",
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
        }, input.diagnostic);
        const result = await engine.recommend({
            userId: input.userId,
            intent: {
                surface: input.surface,
                direction: input.direction,
                mood: input.mood,
                language: input.language,
            },
            sessionId: input.sessionId,
            cursor: input.cursor,
            limit: input.limit * 3,
            perLaneLimit: input.limit,
            exclude: input.excludeVideoIds,
            context: input.context,
        });
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
            ...(languageStatus ? { languageStatus } : {}),
        };
    }

    recommendSimilar(request: RecommendRequest): Promise<RecommendResult> {
        return this.engine(this.dependencies.loadSimilarCandidates).recommend(
            request,
        );
    }
}
