import type {
    PersonalizedCatalogOptions,
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "../personalizedCatalog";
import { buildCanonicalRecordingKey } from "./canonicalIdentity";
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
    RecommendationSurface,
} from "./types";

const MAX_PERSONALIZED_SOURCE_SHELF_LIMIT = 25;
const PERSONALIZED_CANDIDATE_RESERVE_MULTIPLIER = 3;

type CommonEngineDependencies = Omit<
    RecommendationEngineDependencies,
    "loadCandidates"
>;

export interface UnifiedRecommendationDependencies extends CommonEngineDependencies {
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
    excludeVideoIds: string[];
}

export type PersonalizedRecommendationFeed = PersonalizedHomeFeed & {
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
    ): RecommendationEngine {
        return new RecommendationEngine({
            ...this.dependencies,
            loadCandidates,
        });
    }

    async getPersonalizedFeed(
        input: PersonalizedRecommendationInput,
    ): Promise<PersonalizedRecommendationFeed> {
        const sourceState: { feed?: PersonalizedHomeFeed } = {};
        const engine = this.engine(async () => {
            const sourceFeed = await this.dependencies.loadPersonalizedFeed(
                input.userId,
                personalizedSourceShelfLimit(input.limit),
                {
                    cursor: input.cursor,
                    mode: input.direction,
                    ...(input.mood ? { mood: input.mood } : {}),
                    ...(input.excludeVideoIds.length > 0
                        ? { excludeVideoIds: input.excludeVideoIds }
                        : {}),
                },
            );
            sourceState.feed = sourceFeed;
            return {
                candidates: flattenPersonalizedFeed(sourceFeed),
                nextCursor: sourceFeed.nextCursor,
                degradedSources:
                    (sourceFeed.degradedSources?.length ?? 0) > 0
                        ? (sourceFeed.degradedSources ?? [])
                        : sourceFeed.degraded && sourceFeed.reason
                          ? [sourceFeed.reason]
                          : [],
            };
        });
        const result = await engine.recommend({
            userId: input.userId,
            intent: {
                surface: input.surface,
                direction: input.direction,
                mood: input.mood,
            },
            sessionId: input.sessionId,
            cursor: input.cursor,
            limit: input.limit * 3,
            perLaneLimit: input.limit,
            exclude: input.excludeVideoIds,
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
        };
    }

    recommendSimilar(request: RecommendRequest): Promise<RecommendResult> {
        return this.engine(this.dependencies.loadSimilarCandidates).recommend(
            request,
        );
    }
}
