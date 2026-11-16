import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { parseBoundedInt } from "../utils/queryParams";
import { TRACK_VISIBLE_WHERE } from "../utils/librarySorting";
import { z } from "zod";
import { trackMappingService } from "../services/trackMappingService";
import { resolveRemoteTrackMetadataForRequest } from "../services/remoteTrackMetadataResolver";
import {
    type UnifiedTrackResponse,
    normalizeLocalTrack,
    normalizeTidalTrack,
    normalizeYtMusicTrack,
} from "../services/unifiedTrackResponse";
import {
    forwardScrobbleIsolated,
    forwardTrackReferenceIsolated,
} from "../services/scrobbleForwarder";
import { sendInternalRouteError } from "../utils/routeErrorResponse";
import { recommendationExposureStore } from "../services/recommendations/exposureStore";
import {
    musicSourcePlayRecordingSchema,
    normalizeMusicSourcePlaySnapshot,
} from "../services/musicSourcePlaySnapshot";
import {
    playRequestTrace,
    type PlayRequestTrace,
} from "../services/playRequestTrace";
import { playAccounting } from "../services/playAccounting";
import {
    classifyPlayAccountingFailure,
    playPayloadSchema,
    playEngagementSchema,
    monotonicEngagementFilter,
} from "../services/playAccountingProtocol";

const router = Router();

router.use(requireAuth);

const playSchema = playPayloadSchema;

async function recommendationContextData(
    userId: string,
    payload: z.infer<typeof playSchema>,
) {
    const ownedGeneration = payload.recommendationGenerationId
        ? await prisma.recommendationGeneration.findFirst({
              where: {
                  id: payload.recommendationGenerationId,
                  userId,
                  served: true,
              },
              select: { id: true },
          })
        : null;
    return {
        ...(payload.playContext ? { playContext: payload.playContext } : {}),
        ...(payload.waveMode ? { waveMode: payload.waveMode } : {}),
        ...(ownedGeneration
            ? { recommendationGenerationId: ownedGeneration.id }
            : {}),
        ...(payload.recommendationSessionId
            ? { recommendationSessionId: payload.recommendationSessionId }
            : {}),
    };
}

interface RecommendationPlaybackIdentity {
    provider: "library" | "tidal" | "youtube" | "vk" | "yandex";
    providerTrackId: string;
}

async function attributeRecommendationPlayback(
    input: {
        userId: string;
        identity: RecommendationPlaybackIdentity;
        playedAt: Date;
        playId?: string;
        listenedSeconds: number | null;
        completionRatio: number | null;
        outcome: string | null;
        generationId?: string | null;
    },
    trace?: PlayRequestTrace,
): Promise<void> {
    try {
        const attribute = () =>
            recommendationExposureStore.attributePlayback({
                userId: input.userId,
                ...input.identity,
                playedAt: input.playedAt,
                playId: input.playId,
                listenedSeconds: input.listenedSeconds,
                completionRatio: input.completionRatio,
                outcome: input.outcome,
                generationId: input.generationId,
            });
        if (trace) await trace.measure("attribution", attribute);
        else await attribute();
    } catch (error) {
        logger.warn("Recommendation playback attribution failed", {
            userId: input.userId,
            provider: input.identity.provider,
            providerTrackId: input.identity.providerTrackId,
            error,
        });
    }
}

const playHistoryRangeSchema = z.enum(["7d", "30d", "365d", "all"]);
type PlayHistoryRange = z.infer<typeof playHistoryRangeSchema>;

const getHistoryRangeStart = (
    range: Exclude<PlayHistoryRange, "all">,
): Date => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const lookbackDays = range === "7d" ? 7 : range === "30d" ? 30 : 365;
    return new Date(now - lookbackDays * dayMs);
};

/**
 * @openapi
 * /api/plays/summary:
 *   get:
 *     summary: Get play count summaries across time ranges
 *     tags: [Plays]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Play count summaries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 allTime:
 *                   type: integer
 *                 last7Days:
 *                   type: integer
 *                 last30Days:
 *                   type: integer
 *                 last365Days:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /plays/summary (counts for warning/confirmation UI)
router.get("/summary", async (req, res) => {
    try {
        const userId = req.user!.id;
        const now = new Date();
        const sevenDaysAgo = getHistoryRangeStart("7d");
        const thirtyDaysAgo = getHistoryRangeStart("30d");
        const yearAgo = getHistoryRangeStart("365d");

        const [allTime, last7Days, last30Days, last365Days] = await Promise.all(
            [
                prisma.play.count({
                    where: { userId },
                }),
                prisma.play.count({
                    where: {
                        userId,
                        playedAt: { gte: sevenDaysAgo, lte: now },
                    },
                }),
                prisma.play.count({
                    where: {
                        userId,
                        playedAt: { gte: thirtyDaysAgo, lte: now },
                    },
                }),
                prisma.play.count({
                    where: {
                        userId,
                        playedAt: { gte: yearAgo, lte: now },
                    },
                }),
            ],
        );

        res.json({
            allTime,
            last7Days,
            last30Days,
            last365Days,
        });
    } catch (error) {
        logger.error("Get play summary error:", error);
        res.status(500).json({ error: "Failed to get play history summary" });
    }
});

/**
 * @openapi
 * /api/plays/history:
 *   delete:
 *     summary: Clear play history for a given time range
 *     tags: [Plays]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: range
 *         schema:
 *           type: string
 *           enum: [7d, 30d, 365d, all]
 *           default: 30d
 *     responses:
 *       200:
 *         description: Play history cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 range:
 *                   type: string
 *                 deletedCount:
 *                   type: integer
 *       400:
 *         description: Invalid range parameter
 *       401:
 *         description: Not authenticated
 */
// DELETE /plays/history?range=7d|30d|365d|all
router.delete("/history", async (req, res) => {
    try {
        const userId = req.user!.id;
        const parsed = playHistoryRangeSchema.safeParse(
            (req.query.range as string) || "30d",
        );

        if (!parsed.success) {
            return res.status(400).json({
                error: "Invalid range. Expected one of: 7d, 30d, 365d, all",
            });
        }

        const range = parsed.data;
        const result = await playAccounting.clearHistory(userId, range);

        res.json({
            success: true,
            range,
            deletedCount: result.count,
        });
    } catch (error) {
        const classified = classifyPlayAccountingFailure(error);
        if (classified) {
            if (classified.status === 503) res.setHeader("Retry-After", "1");
            return res
                .status(classified.status)
                .json({ error: classified.code, code: classified.code });
        }
        logger.error("Clear play history error:", error);
        res.status(500).json({ error: "Failed to clear play history" });
    }
});

/**
 * @openapi
 * /api/plays:
 *   post:
 *     summary: Log a new play for a track
 *     description: X-Soundspan-Diagnostic playback validates the payload but returns a diagnostic ID without storing playback or forwarding scrobbles. Optional X-Soundspan-Playback-Run and X-Soundspan-Play-Attempt headers carry anonymous correlation IDs matching [A-Za-z0-9_-] with at most 64 characters. Correlation is not authentication or idempotency support.
 *     parameters:
 *       - in: header
 *         name: X-Soundspan-Diagnostic
 *         schema:
 *           type: string
 *           enum: [playback]
 *     tags: [Plays]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required: [trackId]
 *                 not:
 *                   anyOf:
 *                     - required: [tidalTrackId]
 *                     - required: [youtubeVideoId]
 *                     - required: [musicSourceRecording]
 *                 properties:
 *                   trackId:
 *                     type: string
 *                     minLength: 1
 *                     description: Local library track ID
 *                   playContext:
 *                     type: string
 *                     enum: [wave, home, search, playlist, album, artist, library]
 *                   waveMode:
 *                     type: string
 *                     enum: [for-you, new, familiar]
 *               - type: object
 *                 required: [youtubeVideoId, title, artist, album, duration]
 *                 not:
 *                   anyOf:
 *                     - required: [trackId]
 *                     - required: [tidalTrackId]
 *                     - required: [musicSourceRecording]
 *                 properties:
 *                   youtubeVideoId:
 *                     type: string
 *                     minLength: 1
 *                   title:
 *                     type: string
 *                     minLength: 1
 *                   artist:
 *                     type: string
 *                     minLength: 1
 *                   album:
 *                     type: string
 *                     minLength: 1
 *                   duration:
 *                     type: integer
 *                     minimum: 0
 *                     description: Track duration in seconds
 *                   thumbnailUrl:
 *                     type: string
 *                     minLength: 1
 *                   playContext:
 *                     type: string
 *                     enum: [wave, home, search, playlist, album, artist, library]
 *                   waveMode:
 *                     type: string
 *                     enum: [for-you, new, familiar]
 *               - type: object
 *                 required: [musicSourceRecording]
 *                 not:
 *                   anyOf:
 *                     - required: [trackId]
 *                     - required: [youtubeVideoId]
 *                     - required: [tidalTrackId]
 *                 properties:
 *                   musicSourceRecording:
 *                     type: object
 *                     description: Private owner-claimed display and replay snapshot. Unknown fields are stripped and cannot become shared catalog metadata.
 *                     required: [provider, id, title, artists, duration, contentVersion, preview]
 *                     properties:
 *                       provider:
 *                         type: string
 *                         enum: [vk, yandex]
 *                       id:
 *                         type: string
 *                         maxLength: 42
 *                       title:
 *                         type: string
 *                         minLength: 1
 *                         maxLength: 200
 *                       artists:
 *                         type: array
 *                         minItems: 1
 *                         maxItems: 10
 *                         items:
 *                           type: string
 *                           minLength: 1
 *                           maxLength: 100
 *                       duration:
 *                         type: number
 *                         minimum: 0
 *                         exclusiveMinimum: true
 *                         maximum: 3600
 *                       contentVersion:
 *                         type: string
 *                         enum: [explicit, clean, unknown]
 *                       preview:
 *                         type: boolean
 *                         enum: [false]
 *                       isrc:
 *                         type: string
 *                         pattern: '^[A-Za-z]{2}[A-Za-z0-9]{3}[0-9]{7}$'
 *                     oneOf:
 *                       - properties:
 *                           provider:
 *                             enum: [vk]
 *                           id:
 *                             pattern: '^-?[0-9]{1,20}_[0-9]{1,20}$'
 *                       - properties:
 *                           provider:
 *                             enum: [yandex]
 *                           id:
 *                             pattern: '^[0-9]{1,20}$'
 *                   playContext:
 *                     type: string
 *                     enum: [wave, home, search, playlist, album, artist, library]
 *                   waveMode:
 *                     type: string
 *                     enum: [for-you, new, familiar]
 *     responses:
 *       200:
 *         description: Play write acknowledged, independently of final listened engagement
 *         headers:
 *           X-Soundspan-Play-Trace:
 *             description: API request correlation ID
 *             schema:
 *               type: string
 *               maxLength: 64
 *           X-Soundspan-Play-Write:
 *             description: Observed Prisma write state, not a listened or idempotency capability
 *             schema:
 *               type: string
 *               enum: [not_started, inflight, committed, unknown]
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Track not found
 */
// POST /plays
router.post("/idempotent", async (req, res) => {
    const trace = playRequestTrace(res);
    res.setHeader("Cache-Control", "private, no-store");
    try {
        const payload = await trace.measure("validation", () =>
            playPayloadSchema.parse(req.body),
        );
        if (req.headers?.["x-soundspan-diagnostic"] === "playback") {
            return res
                .status(400)
                .json({ error: "play_creation_diagnostic_not_supported" });
        }
        const response = await playAccounting.createOrReplay(
            req.user!.id,
            req.body?.clientPlaybackId,
            payload,
            async () => {
                if (payload.musicSourceRecording) return {};
                const resolved = await trace.measure("metadata", () =>
                    resolveRemoteTrackMetadataForRequest({
                        provider: "youtube",
                        userId: req.user!.id,
                        videoId: payload.youtubeVideoId!,
                        metadata: {
                            title: payload.title,
                            artist: payload.artist,
                            album: payload.album,
                            duration: payload.duration,
                            thumbnailUrl: payload.thumbnailUrl,
                        },
                    }),
                );
                const identity = await trace.measure("identity", () =>
                    trackMappingService.ensureRemoteTrack({
                        provider: "youtube",
                        videoId: payload.youtubeVideoId!,
                        ...resolved,
                    }),
                );
                return {
                    trackYtMusicId: identity.id,
                    deliveryTrack: {
                        title: resolved.title,
                        artist: resolved.artist,
                        album: resolved.album,
                        durationSeconds: resolved.duration,
                    },
                };
            },
            () => trace.beginWrite(),
            () => trace.beginReadLock(),
        );
        trace.respond();
        return res.json(response);
    } catch (error) {
        const classified = classifyPlayAccountingFailure(error);
        if (classified) {
            if (classified.status === 503) res.setHeader("Retry-After", "1");
            return res
                .status(classified.status)
                .json({ error: classified.code, code: classified.code });
        }
        if (error instanceof z.ZodError)
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        logger.error("Idempotent play creation failed", {
            errorType: error instanceof Error ? error.name : "unknown",
        });
        return sendInternalRouteError(res, "Failed to log play");
    }
});

router.post("/", async (req, res) => {
    const trace = playRequestTrace(res);
    try {
        const userId = req.user!.id;
        if (
            req.body &&
            Object.prototype.hasOwnProperty.call(req.body, "clientPlaybackId")
        ) {
            return res
                .status(400)
                .json({ error: "play_creation_versioned_path_required" });
        }
        const requestedTrackId =
            req.body && typeof req.body === "object"
                ? (req.body as { trackId?: unknown }).trackId
                : undefined;
        if (
            (req.body &&
                typeof req.body === "object" &&
                Object.prototype.hasOwnProperty.call(
                    req.body,
                    "tidalTrackId",
                )) ||
            (typeof requestedTrackId === "string" &&
                requestedTrackId.trim().toLowerCase().startsWith("tidal:"))
        ) {
            return res.status(400).json({ error: "retired_provider" });
        }
        const payload = await trace.measure("validation", () =>
            playSchema.parse(req.body),
        );
        // Explicit per-request diagnostics, never infer testing from fast skips.
        // Do not create a Play, attribute exposure, resolve metadata or scrobble.
        if (req.headers?.["x-soundspan-diagnostic"] === "playback") {
            trace.respond();
            return res.json({ id: "diagnostic-playback", diagnostic: true });
        }
        const recommendationContext = await trace.measure("context", () =>
            recommendationContextData(userId, payload),
        );

        if (payload.musicSourceRecording) {
            const recording = payload.musicSourceRecording;
            const playedAt = new Date();
            // The shared row is an identity namespace only. Client-claimed metadata
            // belongs to this owner's Play and never enters canonical or scrobble writers.
            const play = await trace.write(() =>
                prisma.$transaction(async (transaction) => {
                    const identity = await transaction.trackMusicSource.upsert({
                        where: {
                            provider_providerTrackId: {
                                provider: recording.provider,
                                providerTrackId: recording.id,
                            },
                        },
                        update: { providerTrackId: recording.id },
                        create: {
                            provider: recording.provider,
                            providerTrackId: recording.id,
                        },
                    });
                    return transaction.play.create({
                        data: {
                            userId,
                            trackMusicSourceId: identity.id,
                            musicSourceRecording: recording,
                            source:
                                recording.provider === "vk" ? "VK" : "YANDEX",
                            playedAt,
                            ...recommendationContext,
                        },
                    });
                }),
            );
            await attributeRecommendationPlayback(
                {
                    userId,
                    identity: {
                        provider: recording.provider,
                        providerTrackId: recording.id,
                    },
                    playedAt,
                    playId: play.id,
                    listenedSeconds: null,
                    completionRatio: null,
                    outcome: null,
                    generationId:
                        recommendationContext.recommendationGenerationId,
                },
                trace,
            );
            trace.respond();
            return res.json(play);
        }

        if (payload.trackId) {
            // Verify local track exists
            const track = await trace.measure("track_lookup", () =>
                prisma.track.findUnique({
                    where: { id: payload.trackId, ...TRACK_VISIBLE_WHERE },
                }),
            );

            if (!track) {
                return res.status(404).json({ error: "Track not found" });
            }

            const playedAt = new Date();
            const play = await trace.write(() =>
                prisma.play.create({
                    data: {
                        userId,
                        trackId: payload.trackId!,
                        source: "LIBRARY",
                        playedAt,
                        ...recommendationContext,
                    },
                }),
            );

            forwardTrackReferenceIsolated({
                userId,
                mediaType: "music",
                kind: "scrobble",
                listenedAt: playedAt,
                reference: { source: "local", id: payload.trackId },
            });

            await attributeRecommendationPlayback(
                {
                    userId,
                    identity: {
                        provider: "library",
                        providerTrackId: payload.trackId,
                    },
                    playedAt,
                    playId: play.id,
                    listenedSeconds: null,
                    completionRatio: null,
                    outcome: null,
                    generationId:
                        recommendationContext.recommendationGenerationId,
                },
                trace,
            );

            trace.respond();
            return res.json(play);
        }

        const resolvedMetadata = await trace.measure("metadata", () =>
            resolveRemoteTrackMetadataForRequest({
                provider: "youtube",
                userId,
                videoId: payload.youtubeVideoId!,
                metadata: {
                    title: payload.title,
                    artist: payload.artist,
                    album: payload.album,
                    duration: payload.duration,
                    thumbnailUrl: payload.thumbnailUrl,
                },
            }),
        );
        const ensured = await trace.measure("identity", () =>
            trackMappingService.ensureRemoteTrack({
                provider: "youtube",
                videoId: payload.youtubeVideoId!,
                title: resolvedMetadata.title,
                artist: resolvedMetadata.artist,
                album: resolvedMetadata.album,
                duration: resolvedMetadata.duration,
                thumbnailUrl: resolvedMetadata.thumbnailUrl,
            }),
        );
        const playedAt = new Date();
        const play = await trace.write(() =>
            prisma.play.create({
                data: {
                    userId,
                    trackYtMusicId: ensured.id,
                    source: "YOUTUBE_MUSIC",
                    playedAt,
                    ...recommendationContext,
                },
            }),
        );

        forwardScrobbleIsolated({
            userId,
            mediaType: "music",
            kind: "scrobble",
            listenedAt: playedAt,
            track: {
                title: resolvedMetadata.title,
                artist: resolvedMetadata.artist,
                album: resolvedMetadata.album,
                durationSeconds: resolvedMetadata.duration,
            },
        });

        await attributeRecommendationPlayback(
            {
                userId,
                identity: {
                    provider: "youtube",
                    providerTrackId: payload.youtubeVideoId!,
                },
                playedAt,
                playId: play.id,
                listenedSeconds: null,
                completionRatio: null,
                outcome: null,
                generationId: recommendationContext.recommendationGenerationId,
            },
            trace,
        );

        trace.respond();
        return res.json(play);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        logger.error("Create play error:", error);
        res.status(500).json({ error: "Failed to log play" });
    }
});

/**
 * @openapi
 * /api/plays/{playId}/engagement:
 *   patch:
 *     summary: Record the final playback outcome used by recommendations
 *     description: X-Soundspan-Diagnostic playback validates the payload and acknowledges it without changing engagement or recommendation attribution. Optional X-Soundspan-Playback-Run and X-Soundspan-Play-Attempt headers carry anonymous correlation IDs matching [A-Za-z0-9_-] with at most 64 characters. Response correlation does not authorize retries.
 *     tags: [Plays]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Soundspan-Diagnostic
 *         schema:
 *           type: string
 *           enum: [playback]
 *       - in: path
 *         name: playId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listenedSeconds, completionRatio, outcome]
 *             properties:
 *               listenedSeconds:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 86400
 *               completionRatio:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1
 *               outcome:
 *                 type: string
 *                 enum: [meaningful, completed, skipped, failed]
 *     responses:
 *       200:
 *         description: Engagement recorded
 *         headers:
 *           X-Soundspan-Play-Trace:
 *             description: API request correlation ID
 *             schema:
 *               type: string
 *               maxLength: 64
 *           X-Soundspan-Play-Write:
 *             description: Observed Prisma command completion; a stale PATCH can update no rows
 *             schema:
 *               type: string
 *               enum: [not_started, inflight, committed, unknown]
 *       400:
 *         description: Invalid engagement payload
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Play does not belong to the authenticated user
 */
router.patch("/:playId/engagement", async (req, res) => {
    const trace = playRequestTrace(res);
    const { playId, engagement } = await trace.measure("validation", () => ({
        playId: z.string().trim().min(1).max(128).safeParse(req.params.playId),
        engagement: playEngagementSchema.safeParse(req.body),
    }));
    if (!playId.success || !engagement.success) {
        return res.status(400).json({
            error: "Invalid engagement",
            details: [
                ...(!playId.success ? playId.error.issues : []),
                ...(!engagement.success ? engagement.error.issues : []),
            ],
        });
    }

    if (req.headers?.["x-soundspan-diagnostic"] === "playback") {
        trace.respond();
        return res.json({ success: true, diagnostic: true });
    }

    try {
        const keyedResult = await playAccounting.updateEngagement(
            req.user!.id,
            playId.data,
            engagement.data,
            () => trace.beginWrite(),
        );
        if (keyedResult) {
            trace.respond();
            return res.json(keyedResult);
        }
        const result = await trace.write(() =>
            prisma.play.updateMany({
                where: {
                    id: playId.data,
                    userId: req.user!.id,
                    ...monotonicEngagementFilter(engagement.data),
                },
                data: {
                    ...engagement.data,
                    engagementUpdatedAt: new Date(),
                },
            }),
        );
        if (result.count === 0) {
            const existing = await trace.measure("track_lookup", () =>
                prisma.play.findFirst({
                    where: { id: playId.data, userId: req.user!.id },
                    select: { id: true },
                }),
            );
            if (!existing) {
                return res.status(404).json({ error: "Play not found" });
            }
            trace.respond();
            return res.json({ success: true, stale: true });
        }
        const attributedPlay = await trace.measure("track_lookup", () =>
            prisma.play.findFirst({
                where: { id: playId.data, userId: req.user!.id },
                select: {
                    trackId: true,
                    playedAt: true,
                    trackTidal: { select: { tidalId: true } },
                    trackYtMusic: { select: { videoId: true } },
                    trackMusicSource: {
                        select: { provider: true, providerTrackId: true },
                    },
                    source: true,
                    musicSourceRecording: true,
                    recommendationGenerationId: true,
                },
            }),
        );
        const directTrack = attributedPlay
            ? normalizeMusicSourcePlaySnapshot(attributedPlay)
            : null;
        const identity: RecommendationPlaybackIdentity | null = directTrack
            ? {
                  provider: directTrack.source,
                  providerTrackId: directTrack.musicSourceRecording.id,
              }
            : attributedPlay?.trackYtMusic?.videoId
              ? {
                    provider: "youtube",
                    providerTrackId: attributedPlay.trackYtMusic.videoId,
                }
              : attributedPlay?.trackTidal?.tidalId
                ? {
                      provider: "tidal",
                      providerTrackId: String(
                          attributedPlay.trackTidal.tidalId,
                      ),
                  }
                : attributedPlay?.trackId
                  ? {
                        provider: "library",
                        providerTrackId: attributedPlay.trackId,
                    }
                  : null;
        if (attributedPlay && identity) {
            await attributeRecommendationPlayback(
                {
                    userId: req.user!.id,
                    identity,
                    playedAt: attributedPlay.playedAt,
                    playId: playId.data,
                    listenedSeconds: engagement.data.listenedSeconds,
                    completionRatio: engagement.data.completionRatio,
                    outcome: engagement.data.outcome,
                    generationId: attributedPlay.recommendationGenerationId,
                },
                trace,
            );
        }
        trace.respond();
        return res.json({ success: true });
    } catch (error) {
        const classified = classifyPlayAccountingFailure(error);
        if (classified) {
            if (classified.status === 404)
                return res.status(404).json({ error: "Play not found" });
            if (classified.status === 503) res.setHeader("Retry-After", "1");
            return res
                .status(classified.status)
                .json({ error: classified.code, code: classified.code });
        }
        logger.error("Update play engagement error:", error);
        return sendInternalRouteError(res, "Failed to update engagement");
    }
});

/**
 * @openapi
 * /api/plays:
 *   get:
 *     summary: Get recent plays for the authenticated user
 *     tags: [Plays]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 200
 *     responses:
 *       200:
 *         description: List of recent plays with track details
 *       401:
 *         description: Not authenticated
 */
// GET /plays (recent plays for user)
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const limit = parseBoundedInt(req.query.limit, 50, 1, 200);

        const plays = await prisma.play.findMany({
            where: { userId },
            orderBy: { playedAt: "desc" },
            take: limit,
            include: {
                track: {
                    include: {
                        federationPeer: {
                            select: {
                                id: true,
                                name: true,
                                outboundStatus: true,
                            },
                        },
                        album: {
                            include: {
                                artist: {
                                    select: {
                                        id: true,
                                        name: true,
                                        mbid: true,
                                    },
                                },
                            },
                        },
                    },
                },
                trackTidal: true,
                trackYtMusic: true,
                trackMusicSource: true,
            },
        });

        res.json(
            plays
                .map((play) => {
                    const directTrack = normalizeMusicSourcePlaySnapshot(play);
                    if (directTrack)
                        return {
                            id: play.id,
                            playedAt: play.playedAt,
                            source: play.source,
                            track: directTrack,
                        };
                    if (play.track) {
                        const normalized = normalizeLocalTrack(
                            play.track as any,
                        );
                        return {
                            id: play.id,
                            playedAt: play.playedAt,
                            source: play.source,
                            track: toHistoryTrackShape(
                                normalized,
                                Boolean(play.track.removedAt),
                            ),
                        };
                    }
                    if (play.trackTidal) {
                        const normalized = normalizeTidalTrack(play.trackTidal);
                        return {
                            id: play.id,
                            playedAt: play.playedAt,
                            source: play.source,
                            track: toHistoryTrackShape(normalized),
                        };
                    }
                    if (play.trackYtMusic) {
                        const normalized = normalizeYtMusicTrack(
                            play.trackYtMusic,
                        );
                        return {
                            id: play.id,
                            playedAt: play.playedAt,
                            source: play.source,
                            track: toHistoryTrackShape(normalized),
                        };
                    }
                    return null;
                })
                .filter(
                    (entry): entry is NonNullable<typeof entry> =>
                        entry !== null,
                ),
        );
    } catch (error) {
        logger.error("Get plays error:", error);
        res.status(500).json({ error: "Failed to get plays" });
    }
});

export default router;
const toHistoryTrackShape = (
    normalized: UnifiedTrackResponse,
    isRemoved = false,
) => {
    const base = {
        id: normalized.id,
        title: normalized.title,
        displayTitle: normalized.displayTitle ?? null,
        duration: normalized.duration,
        trackNo: normalized.trackNo,
        source: normalized.source,
        provider: normalized.provider,
        filePath: normalized.filePath ?? null,
        artist: normalized.artist,
        album: {
            ...normalized.album,
            artist: normalized.artist,
        },
        ...(isRemoved
            ? {
                  playback: {
                      isPlayable: false,
                      reason: "track_removed" as const,
                      message:
                          "Playback is unavailable because this track was removed from the library.",
                  },
              }
            : {}),
    };

    if (normalized.source === "tidal") {
        return {
            ...base,
            streamSource: "tidal" as const,
            tidalTrackId: normalized.provider.tidalTrackId,
        };
    }
    if (normalized.source === "youtube") {
        return {
            ...base,
            streamSource: "youtube" as const,
            youtubeVideoId: normalized.provider.youtubeVideoId,
        };
    }
    if (normalized.source === "federated") {
        return { ...base, streamSource: "peer" as const };
    }
    return base;
};
