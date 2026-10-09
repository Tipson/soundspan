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
import { prisma } from "../../utils/db";
import { readVerifiedMusicSourceRecording } from "../../services/musicSources/verifiedMetadata";
import { MusicSourceError } from "../../services/musicSources/types";

/**
 * Router segment for remoteTracks routes registered at this position.
 */
export const remoteTracksRouter = Router();
const remoteTrackPreferenceLogger = logger.child("RemoteTrackPreference");
// Remote preferences: YouTube, exact VK/Yandex, historical TIDAL reads/clears.

/**
 * @openapi
 * /api/library/remote-tracks/{id}/preference:
 *   get:
 *     summary: Get the owner's remote track preference
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: "Exact composite track ID: yt:videoId, vk:ownerId_audioId, yandex:trackId, or historical tidal:trackId."
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
            error: "Invalid remote track ID.",
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
): Promise<RemoteTrackLikeTarget> {
    if (parsed.provider === "vk" || parsed.provider === "yandex") {
        const namespace = await prisma.trackMusicSource.findUnique({
            where: {
                provider_providerTrackId: {
                    provider: parsed.provider,
                    providerTrackId: parsed.externalId,
                },
            },
        });
        if (
            namespace?.provider !== parsed.provider ||
            namespace.providerTrackId !== parsed.externalId ||
            !readVerifiedMusicSourceRecording(namespace)
        )
            throw new MusicSourceError("not_found");
        return { provider: parsed.provider, trackMusicSourceId: namespace.id };
    }
    if (parsed.provider !== "youtube") {
        throw new Error("Retired TIDAL preferences cannot be materialized");
    }
    const resolved = await resolveRemoteTrackMetadataForRequest({
        provider: "youtube",
        userId,
        videoId: parsed.externalId,
        fetchArtworkIfMissing: true,
        metadata,
    });
    const ensured = await trackMappingService.ensureRemoteTrack({
        provider: "youtube",
        videoId: parsed.externalId,
        title: resolved.title,
        artist: resolved.artist,
        album: resolved.album,
        duration: resolved.duration,
        thumbnailUrl: resolved.thumbnailUrl,
    });
    return { provider: "youtube", trackYtMusicId: ensured.id };
}

/**
 * @openapi
 * /api/library/remote-tracks/{id}/preference:
 *   post:
 *     summary: Set preference for a remote track
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: "Exact yt:videoId, vk:ownerId_audioId or yandex:trackId. Direct likes require existing server-confirmed recording facts; tidal:trackId only supports clearing historical state."
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
 *                 description: YouTube display metadata only; ignored for direct VK/Yandex identities.
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
 *       404:
 *         description: Direct track has no valid server-confirmed recording metadata
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
            error: "Invalid remote track ID.",
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
    if (parsed.provider === "tidal" && signal !== "clear") {
        return res.status(400).json({ error: "retired_provider" });
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
            likedTarget = await resolveLikedRemoteTrack(
                parsed,
                userId,
                metadata,
            );
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
        if (
            (parsed.provider === "vk" || parsed.provider === "yandex") &&
            error instanceof MusicSourceError &&
            error.code === "not_found"
        )
            return sendRouteError(res, 404, "track_not_verified");
        throw error;
    }

    res.json(formatTrackPreferenceResponse(req.params.id, preference));
}

remoteTracksRouter.post(
    "/remote-tracks/:id/preference",
    asyncHandler(handleSetRemoteTrackPreference),
);
