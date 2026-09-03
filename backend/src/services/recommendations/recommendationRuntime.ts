import { config } from "../../config";
import { logger } from "../../utils/logger";
import {
    personalizedCatalogService,
    type PersonalizedHomeFeed,
} from "../personalizedCatalog";
import { ytMusicService, type YtMusicRadioTrack } from "../youtubeMusic";
import {
    buildCanonicalRecordingKey,
    canonicalIdentityResolver,
} from "./canonicalIdentity";
import { recommendationExposureStore } from "./exposureStore";
import { recommendationFeatureStore } from "./featureStore";
import { recommendationMoodEmbeddingStore } from "./moodEmbedding";
import { remoteAnalysisHotSetScheduler } from "./remoteAnalysisHotSet";
import { UnifiedRecommendationService } from "./recommendationService";
import type { RecommendRequest, RecommendationCandidate } from "./types";

const log = logger.child("RecommendationRuntime");

function seedYoutubeVideoId(seedId: string | undefined): string | null {
    if (!seedId) return null;
    for (const prefix of ["yt:", "related-yt-", "youtube:"]) {
        if (seedId.startsWith(prefix)) {
            return seedId.slice(prefix.length).trim() || null;
        }
    }
    return null;
}

function radioCandidate(track: YtMusicRadioTrack): RecommendationCandidate {
    const candidate: RecommendationCandidate = {
        id: `yt:${track.videoId}`,
        canonicalKey: "",
        title: track.title,
        duration: Math.max(0, Math.round(track.duration)),
        trackNo: null,
        artist: { id: track.artistId ?? null, name: track.artist },
        album: {
            id: track.albumId ?? null,
            title: track.album || "Single",
            coverArt:
                track.thumbnailUrl ??
                `https://i.ytimg.com/vi/${encodeURIComponent(track.videoId)}/hqdefault.jpg`,
        },
        source: "youtube",
        provider: {
            tidalTrackId: null,
            youtubeVideoId: track.videoId,
        },
        streamSource: "youtube",
        youtubeVideoId: track.videoId,
        candidateSources: ["youtube-radio"],
        providerPrior: 1,
        lane: "discovery",
    };
    candidate.canonicalKey = buildCanonicalRecordingKey(candidate);
    return candidate;
}

async function loadSimilarCandidates(request: RecommendRequest) {
    const requestedLimit = Math.min(50, Math.max(12, request.limit * 3));
    try {
        let seedVideoId = seedYoutubeVideoId(request.seed?.id);
        if (!seedVideoId && request.seed?.artist && request.seed.title) {
            const match = await ytMusicService.findMatchForTrack(
                request.userId,
                request.seed.artist,
                request.seed.title,
            );
            seedVideoId = match?.videoId ?? null;
        }
        if (!seedVideoId) {
            return {
                candidates: [],
                nextCursor: request.cursor ?? 0,
                degradedSources: ["youtube-seed"],
            };
        }
        const radio = await ytMusicService.getRadio(
            seedVideoId,
            requestedLimit + 1,
        );
        const seen = new Set([seedVideoId]);
        const candidates = radio.tracks.flatMap((track) => {
            if (!track.videoId || seen.has(track.videoId)) return [];
            seen.add(track.videoId);
            return [radioCandidate(track)];
        });
        const cursor = request.cursor ?? 0;
        const offset = candidates.length > 0 ? cursor % candidates.length : 0;
        return {
            candidates: [
                ...candidates.slice(offset),
                ...candidates.slice(0, offset),
            ],
            nextCursor: cursor >= 1_000_000 ? 0 : cursor + 1,
            degradedSources: [],
        };
    } catch (error) {
        log.warn("Similar-track provider adapter degraded", {
            userId: request.userId,
            seed: request.seed?.id,
            error,
        });
        return {
            candidates: [],
            nextCursor: request.cursor ?? 0,
            degradedSources: ["youtube"],
        };
    }
}

export const unifiedRecommendationService = new UnifiedRecommendationService({
    mode: config.recommendations.mode,
    hybridRolloutPercent: config.recommendations.hybridRolloutPercent,
    explorationRate: config.recommendations.explorationRate,
    loadPersonalizedFeed: (
        userId,
        limit,
        options,
    ): Promise<PersonalizedHomeFeed> =>
        personalizedCatalogService.getHomeFeed(userId, limit, options),
    loadSimilarCandidates,
    resolveCanonical: (candidate) =>
        canonicalIdentityResolver.resolve(candidate),
    enrichCandidates: (candidates) =>
        recommendationFeatureStore.enrichCandidates(candidates),
    loadRecentExposures: (userId, now) =>
        recommendationExposureStore.loadRecent(userId, now),
    loadDislikedCanonicalKeys: (userId) =>
        recommendationFeatureStore.loadDislikedCanonicalKeys(userId),
    loadTasteContext: async (userId, request) => {
        const [taste, mood] = await Promise.all([
            recommendationFeatureStore.loadTasteContext(userId, {
                sessionId: request.sessionId,
                surface: request.intent.surface,
                context: request.context,
            }),
            recommendationMoodEmbeddingStore.load(request.intent.mood ?? null),
        ]);
        const enrichedTaste = {
            ...taste,
            moodEmbedding: mood.embedding,
            degradedSources: mood.degraded ? ["dclap-mood"] : [],
        };
        if (request.intent.surface !== "similar-tracks" || !request.seed?.id) {
            return enrichedTaste;
        }
        const seedEmbedding =
            await recommendationFeatureStore.loadSeedEmbedding(request.seed.id);
        return seedEmbedding
            ? {
                  ...enrichedTaste,
                  positiveCentroids: [
                      seedEmbedding,
                      ...taste.positiveCentroids,
                  ].slice(0, 5),
              }
            : enrichedTaste;
    },
    recordGeneration: (input) => recommendationExposureStore.record(input),
    scheduleHotSet: (input) => remoteAnalysisHotSetScheduler.schedule(input),
    now: () => new Date(),
});
