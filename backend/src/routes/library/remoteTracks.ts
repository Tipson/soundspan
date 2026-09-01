import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import path from "path";
import {
    applyTrackPreferenceOrderBias,
    applyTrackPreferenceSimilarityBias,
    normalizeTrackPreferenceSignal,
} from "../../services/trackPreference";
import {
    applyRemoteTrackPreferenceSignal,
    applyTrackPreferenceSignalToTrackIds,
    buildTrackPreferenceScoreMapForUser,
    cancelRemoteTrackPreferenceIntent,
    formatAlbumPreferenceResponse,
    formatTrackPreferenceResponse,
    hasConnectedProviderToken,
    loadRemoteTrackPreference,
    parseRemoteTrackPreferenceReference,
    reserveRemoteTrackPreferenceIntent,
    toLikedResponseTrack,
    type RemoteTrackLikeTarget,
    type RemoteTrackPreferenceReference,
} from "../../services/libraryTrackPreferences";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../../utils/routeErrorResponse";
import { trackMappingService } from "../../services/trackMappingService";
import { resolveRemoteTrackMetadataForRequest } from "../../services/remoteTrackMetadataResolver";
import { logger } from "../../utils/logger";

/**
 * Router segment for remoteTracks routes registered at this position.
 */
export const remoteTracksRouter = Router();
const remoteTrackPreferenceLogger = logger.child("RemoteTrackPreference");
// ── Remote Track Preference (YT Music / TIDAL) ─────────────────

/**
 * @openapi
 * /api/library/remote-tracks/{id}/preference:
 *   get:
 *     summary: Get preference for a remote (YT/TIDAL) track
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: "Composite track ID (yt:videoId or tidal:trackId)"
 *     responses:
 *       200:
 *         description: Remote track preference state
 *       400:
 *         description: Invalid remote track ID format
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles GET /api/library/remote-tracks/:id/preference.
 */
export async function handleGetRemoteTrackPreference(
    req: Request<{ id: string }>,
    res: Response,
) {
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required");
    }

    const parsed = parseRemoteTrackPreferenceReference(req.params.id);
    if (!parsed) {
        return res.status(400).json({
            error: "Invalid remote track ID. Use yt:videoId or tidal:trackId format.",
        });
    }

    const preference = await loadRemoteTrackPreference(userId, parsed);

    res.json(formatTrackPreferenceResponse(req.params.id, preference));
}

remoteTracksRouter.get(
    "/remote-tracks/:id/preference",
    asyncHandler(handleGetRemoteTrackPreference),
);

type RemotePreferenceMetadata = {
    title?: string;
    artist?: string;
    album?: string;
    thumbnailUrl?: string;
    duration?: number;
    isrc?: string;
};

function readRemotePreferenceMetadata(body: unknown): RemotePreferenceMetadata {
    if (typeof body !== "object" || body === null) return {};
    const requestBody = body as { metadata?: unknown };
    const source =
        typeof requestBody.metadata === "object" &&
        requestBody.metadata !== null
            ? requestBody.metadata
            : body;
    return source as RemotePreferenceMetadata;
}

async function resolveLikedRemoteTrack(
    parsed: RemoteTrackPreferenceReference,
    userId: string,
    metadata: RemotePreferenceMetadata,
) {
    const resolved = await resolveRemoteTrackMetadataForRequest({
        provider: parsed.provider,
        userId,
        ...(parsed.provider === "tidal"
            ? { tidalId: parsed.tidalId }
            : { videoId: parsed.externalId }),
        fetchArtworkIfMissing: true,
        metadata,
    });
    return parsed.provider === "tidal"
        ? trackMappingService.ensureRemoteTrack({
              provider: "tidal",
              tidalId: parsed.tidalId,
              ...resolved,
          })
        : trackMappingService.ensureRemoteTrack({
              provider: "youtube",
              videoId: parsed.externalId,
              title: resolved.title,
              artist: resolved.artist,
              album: resolved.album,
              duration: resolved.duration,
              thumbnailUrl: resolved.thumbnailUrl,
          });
}

/**
 * @openapi
 * /api/library/remote-tracks/{id}/preference:
 *   post:
 *     summary: Set preference for a remote (YT/TIDAL) track
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: "Composite track ID (yt:videoId or tidal:trackId)"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - signal
 *             properties:
 *               signal:
 *                 type: string
 *                 enum: [thumbs_up, thumbs_down, clear]
 *               metadata:
 *                 type: object
 *                 properties:
 *                   title:
 *                     type: string
 *                   artist:
 *                     type: string
 *                   album:
 *                     type: string
 *                   thumbnailUrl:
 *                     type: string
 *                   duration:
 *                     type: integer
 *     responses:
 *       200:
 *         description: Updated remote track preference
 *       400:
 *         description: Invalid remote track ID or signal
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles POST /api/library/remote-tracks/:id/preference.
 */
export async function handleSetRemoteTrackPreference(
    req: Request<{ id: string }>,
    res: Response,
) {
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required");
    }

    const parsed = parseRemoteTrackPreferenceReference(req.params.id);
    if (!parsed) {
        return res.status(400).json({
            error: "Invalid remote track ID. Use yt:videoId or tidal:trackId format.",
        });
    }

    const signal = normalizeTrackPreferenceSignal(
        req.body?.signal ?? req.body?.score ?? req.body?.action,
    );
    if (!signal) {
        return res.status(400).json({
            error: "Invalid preference signal. Use thumbs_up, thumbs_down, or clear.",
        });
    }

    const metadata = readRemotePreferenceMetadata(req.body);
    const now = new Date();
    const intentToken = await reserveRemoteTrackPreferenceIntent({
        userId,
        reference: parsed,
        requestedAt: now,
    });

    let preference: Awaited<
        ReturnType<typeof applyRemoteTrackPreferenceSignal>
    >;
    try {
        let likedTarget: RemoteTrackLikeTarget | undefined;
        if (signal === "thumbs_up") {
            const ensured = await resolveLikedRemoteTrack(
                parsed,
                userId,
                metadata,
            );
            likedTarget =
                ensured.provider === "tidal"
                    ? { provider: "tidal", trackTidalId: ensured.id }
                    : { provider: "youtube", trackYtMusicId: ensured.id };
        }
        preference = await applyRemoteTrackPreferenceSignal({
            userId,
            reference: parsed,
            signal,
            now,
            intentToken,
            likedTarget,
        });
    } catch (error) {
        try {
            await cancelRemoteTrackPreferenceIntent({
                userId,
                reference: parsed,
                intentToken,
            });
        } catch (cleanupError) {
            remoteTrackPreferenceLogger.error(
                "Failed to clean up a failed remote preference intent",
                { cleanupError },
            );
        }
        throw error;
    }

    res.json(formatTrackPreferenceResponse(req.params.id, preference));
}

remoteTracksRouter.post(
    "/remote-tracks/:id/preference",
    asyncHandler(handleSetRemoteTrackPreference),
);
