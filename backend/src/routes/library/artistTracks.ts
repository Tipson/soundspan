import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { prisma, Prisma } from "../../utils/db";
import { sendRouteError } from "../../utils/routeErrorResponse";
import {
    TRACK_VISIBLE_WHERE,
    trackBrowseWhere,
} from "../../utils/librarySorting";

const ARTIST_TRACKS_DEFAULT_LIMIT = 100;
const ARTIST_TRACKS_MAX_LIMIT = 200;
const ARTIST_TRACKS_MAX_OFFSET = 100_000;

function parseArtistTracksPageValue(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    const scalar = typeof value === "string" ? value : "";
    const parsed = Number.parseInt(scalar, 10);
    return Number.isFinite(parsed)
        ? Math.min(max, Math.max(min, parsed))
        : fallback;
}

/**
 * @openapi
 * /api/library/artists/{id}/tracks:
 *   get:
 *     summary: List every visible library track for one artist
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Artist ID, name, or MusicBrainz ID
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, maximum: 100000, default: 0 }
 *     responses:
 *       200:
 *         description: Deterministic paginated artist track list
 *       404:
 *         description: Artist not found
 *       401:
 *         description: Not authenticated
 */
/** Handles GET /api/library/artists/:id/tracks. */
export async function handleGetArtistTracks(
    req: Request<{ id: string }>,
    res: Response,
) {
    const idParam = req.params.id;
    const limit = parseArtistTracksPageValue(
        req.query.limit,
        ARTIST_TRACKS_DEFAULT_LIMIT,
        1,
        ARTIST_TRACKS_MAX_LIMIT,
    );
    const offset = parseArtistTracksPageValue(
        req.query.offset,
        0,
        0,
        ARTIST_TRACKS_MAX_OFFSET,
    );
    const artist = await prisma.artist.findFirst({
        where: {
            OR: [
                { id: idParam },
                { mbid: idParam },
                {
                    name: {
                        equals: idParam,
                        mode: "insensitive" as const,
                    },
                },
            ],
        },
        select: { id: true },
    });

    if (!artist) {
        return sendRouteError(res, 404, "Artist not found");
    }

    const where = {
        AND: [
            TRACK_VISIBLE_WHERE,
            trackBrowseWhere(),
            { album: { artistId: artist.id } },
        ],
    } satisfies Prisma.TrackWhereInput;
    const [trackRows, total] = await Promise.all([
        prisma.track.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy: [
                { album: { title: Prisma.SortOrder.asc } },
                { discNo: Prisma.SortOrder.asc },
                { trackNo: Prisma.SortOrder.asc },
                { title: Prisma.SortOrder.asc },
                { id: Prisma.SortOrder.asc },
            ],
            include: {
                album: {
                    include: {
                        artist: { select: { id: true, name: true } },
                    },
                },
                federationPeer: {
                    select: {
                        id: true,
                        name: true,
                        outboundStatus: true,
                    },
                },
            },
        }),
        prisma.track.count({ where }),
    ]);
    const tracks = trackRows.map(({ federationPeer, ...track }) => ({
        ...track,
        source: track.origin === "FEDERATED" ? "federated" : "local",
        ...(track.origin === "FEDERATED"
            ? { streamSource: "peer" as const }
            : {}),
        peer: federationPeer
            ? {
                  id: federationPeer.id,
                  name: federationPeer.name,
                  online: federationPeer.outboundStatus === "ACTIVE",
              }
            : undefined,
        artist: track.album.artist,
        album: {
            ...track.album,
            coverArt: track.album.coverUrl,
        },
    }));

    res.json({ tracks, total, offset, limit });
}

/** Artist-track browse routes mounted under `/api/library`. */
export const artistTracksRouter = Router();
artistTracksRouter.get(
    "/artists/:id/tracks",
    asyncHandler(handleGetArtistTracks),
);
