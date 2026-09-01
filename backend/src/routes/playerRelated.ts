import { randomUUID } from "node:crypto";
import { Router } from "express";
import { requireAuthOrToken } from "../middleware/auth";
import type { RecommendationCandidate } from "../services/recommendations/types";
import { logger } from "../utils/logger";

const router = Router();
const log = logger.child("PlayerRelated");
const DEFAULT_LIMIT = 12;

router.use(requireAuthOrToken);

function queryText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function parseLimit(value: unknown): number {
    const parsed = Number.parseInt(queryText(value), 10);
    return Number.isFinite(parsed)
        ? Math.max(1, Math.min(25, parsed))
        : DEFAULT_LIMIT;
}

function parseCursor(value: unknown): number {
    const parsed = Number.parseInt(queryText(value), 10);
    return Number.isFinite(parsed)
        ? Math.max(0, Math.min(1_000_000, parsed))
        : 0;
}

function relatedTrack(track: RecommendationCandidate, similarity: number) {
    return {
        id: track.id,
        title: track.title,
        artist: track.artist,
        similarity,
        inLibrary: false,
        matchConfidence: 100,
        duration: track.duration,
        streamSource: track.streamSource,
        youtubeVideoId: track.provider.youtubeVideoId ?? undefined,
        tidalTrackId: track.provider.tidalTrackId ?? undefined,
        recommendationSource: track.candidateSources.join("+") || "hybrid-v2",
        album: {
            id: track.album.id || undefined,
            title: track.album.title || "Single",
            coverArt: track.album.coverArt || undefined,
            artist: track.artist,
        },
    };
}

/**
 * Online-first player recommendations. This route intentionally lives outside
 * DISCOVERY_ENABLED: the player must keep a provider fallback even when the
 * optional Discover subsystem and Last.fm graph are disabled.
 */
router.get("/", async (req, res) => {
    const userId = req.user!.id;
    const seedTrackId = queryText(req.query.seedTrackId);
    const artist = queryText(req.query.artist);
    const title = queryText(req.query.title);
    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const sessionId =
        queryText(req.query.sessionId).slice(0, 128) || randomUUID();

    if (!seedTrackId && (!artist || !title)) {
        return res.status(400).json({
            error: "A provider track id or artist and title are required",
        });
    }

    try {
        const { unifiedRecommendationService } =
            await import("../services/recommendations/recommendationRuntime");
        const exclude = [seedTrackId];
        for (const prefix of ["yt:", "related-yt-", "youtube:"]) {
            if (seedTrackId.startsWith(prefix)) {
                exclude.push(seedTrackId.slice(prefix.length));
                break;
            }
        }
        const result = await unifiedRecommendationService.recommendSimilar({
            userId,
            sessionId,
            intent: {
                surface: "similar-tracks",
                direction: "for-you",
                mood: null,
            },
            cursor,
            limit,
            exclude,
            seed: {
                ...(seedTrackId ? { id: seedTrackId } : {}),
                ...(artist ? { artist } : {}),
                ...(title ? { title } : {}),
            },
        });
        const tracks = result.tracks.map((track, index) =>
            relatedTrack(track, Math.max(0.01, 1 - index / limit)),
        );

        const seenArtists = new Set<string>();
        const artists = result.tracks.flatMap((track) => {
            const normalized = track.artist.name.trim().toLocaleLowerCase();
            if (
                !normalized ||
                normalized === artist.toLocaleLowerCase() ||
                seenArtists.has(normalized)
            ) {
                return [];
            }
            seenArtists.add(normalized);
            return [
                {
                    name: track.artist.name,
                    providerId: track.artist.id || undefined,
                    image: track.album.coverArt || undefined,
                },
            ];
        });

        const seenAlbums = new Set<string>();
        const albums = result.tracks.flatMap((track) => {
            const id = track.album.id?.trim();
            if (!id || !track.album.title || seenAlbums.has(id)) return [];
            seenAlbums.add(id);
            return [
                {
                    id,
                    title: track.album.title,
                    coverArt: track.album.coverArt,
                    provider: track.source,
                },
            ];
        });

        return res.json({
            tracks,
            artists: artists.slice(0, 9),
            albums: albums.slice(0, 6),
            generationId: result.generationId,
            nextCursor: result.nextCursor,
            degradedSources: result.degradedSources,
        });
    } catch (error) {
        log.warn(
            "Provider related-content fallback failed",
            { userId, seedTrackId },
            error,
        );
        return res.status(502).json({
            error: "Related music is temporarily unavailable",
        });
    }
});

export default router;
