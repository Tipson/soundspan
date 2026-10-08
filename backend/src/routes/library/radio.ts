import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { prisma, Prisma } from "../../utils/db";
import { transformRadioTrack } from "../../services/libraryRadioTrackResponse";
import {
    LibrarySeedRadioError,
    selectLibrarySeedRadio,
} from "../../services/librarySeedRadio";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import { allocateTracksWithArtistWeighting } from "../../services/artistSlotAllocation";
import {
    getMergedGenres,
    getArtistDisplaySummary,
} from "../../utils/metadataOverrides";
import { shuffleArray } from "../../utils/shuffle";
import { separateArtists } from "../../utils/separateArtists";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import {
    applyTrackPreferenceOrderBias,
    normalizeTrackPreferenceSignal,
    resolveTrackPreference,
    TRACK_DISLIKE_ENTITY_TYPE,
} from "../../services/trackPreference";
import {
    applyTrackPreferenceSignalToTrackIds,
    buildTrackPreferenceScoreMapForUser,
    formatAlbumPreferenceResponse,
    formatTrackPreferenceResponse,
    hasConnectedProviderToken,
    toLikedResponseTrack,
} from "../../services/libraryTrackPreferences";
import { sendRouteError } from "../../utils/routeErrorResponse";
import {
    buildRemotePlaylistRadio,
    buildRemoteTrackRadio,
    buildRemoteLikedRadio,
    buildRemoteArtistRadio,
} from "../../services/playlistRemoteRadio";
import { buildMultiTrackRadio } from "../../services/libraryRadioBuilder";
import {
    isLibraryRadioPlaylistType,
    selectLibraryRadioStationTracks,
} from "../../services/libraryRadioStationSelection";
import {
    loadDecadeRadioAggregates,
    loadGenreRadioAggregates,
    loadRadioIdCandidatePool,
} from "../../services/libraryRadioCache";
import {
    TRACK_BROWSE_SQL,
    moodPoolCondition,
    VISIBLE_TRACK_SQL,
} from "../../utils/libraryRadioPredicates";
import {
    DEFAULT_MY_LIKED_LIMIT,
    isLibraryDeletionEnabled,
    MAX_LIMIT,
    MY_LIKED_PLAYLIST_DESCRIPTION,
    MY_LIKED_PLAYLIST_ID,
    MY_LIKED_PLAYLIST_NAME,
    parseBooleanQueryParam,
} from "../../utils/libraryRouteSupport";

/**
 * Router segment for radio routes registered at this position.
 */
export const radioRouter = Router();
/**
 * @openapi
 * /api/library/genres:
 *   get:
 *     summary: Get list of genres in the library with track counts
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of genres with track counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 genres:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       genre:
 *                         type: string
 *                       count:
 *                         type: integer
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles GET /api/library/genres.
 */
export async function handleGetGenres(req: Request, res: Response) {
    const genres = await loadGenreRadioAggregates();
    res.json({ genres });
}

radioRouter.get("/genres", asyncHandler(handleGetGenres));

/**
 * @openapi
 * /api/library/decades:
 *   get:
 *     summary: Get available decades in the library with track counts
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of decades with track counts (only decades with 15+ tracks)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 decades:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       decade:
 *                         type: integer
 *                         example: 1990
 *                       count:
 *                         type: integer
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles GET /api/library/decades.
 */
export async function handleGetDecades(req: Request, res: Response) {
    const decades = await loadDecadeRadioAggregates();
    res.json({ decades });
}

radioRouter.get("/decades", asyncHandler(handleGetDecades));

/**
 * @openapi
 * /api/library/radio:
 *   get:
 *     summary: Get radio tracks from the library or supported external catalog
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [all, liked, discovery, favorites, decade, genre, mood, workout, artist, artist-name, vibe, youtube]
 *         description: Radio station type
 *       - in: query
 *         name: value
 *         schema:
 *           type: string
 *         description: Value for the radio type (e.g. decade year, genre name, artist ID, track ID)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of tracks to return
 *     responses:
 *       200:
 *         description: Radio tracks queue
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 sourceFeatures:
 *                   type: object
 *                   description: Source track audio features (only for vibe mode)
 *       400:
 *         description: Radio type is required
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles GET /api/library/radio.
 */
export async function handleGetRadio(req: Request, res: Response) {
    const { type, value, limit = "50" } = req.query;
    let radioType = typeof type === "string" ? type : "";
    let radioValue = typeof value === "string" ? value : undefined;
    const parsedLimit = Number.parseInt(String(limit), 10);
    const normalizedRequestedLimit =
        Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
    const limitNum =
        radioType === "liked"
            ? Math.min(normalizedRequestedLimit, MAX_LIMIT)
            : Math.min(normalizedRequestedLimit, 100);
    const userId = req.user?.id;

    if (!radioType) {
        return sendRouteError(res, 400, "Radio type is required");
    }

    if (radioType === "youtube") {
        const videoId = (radioValue ?? "").trim();
        if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            return sendRouteError(
                res,
                400,
                "Valid YouTube video ID required for track radio",
            );
        }
        return res.json({
            tracks: await buildRemoteTrackRadio(videoId, limitNum),
        });
    }
    if (radioType === "artist-name") {
        const artistName = (radioValue ?? "").trim();
        if (!artistName) {
            return sendRouteError(
                res,
                400,
                "Artist name is required for artist-name radio",
            );
        }

        const matchedArtist = await prisma.artist.findFirst({
            where: { name: { equals: artistName, mode: "insensitive" } },
            select: { id: true },
        });

        if (!matchedArtist) {
            return res.json({
                tracks: await buildRemoteArtistRadio(artistName, limitNum),
            });
        }

        radioType = "artist";
        radioValue = matchedArtist.id;
    }

    if (isLibraryRadioPlaylistType(radioType)) {
        const selection = await selectLibraryRadioStationTracks({
            type: radioType,
            value: radioValue,
            limit: limitNum,
            userId: userId ?? "",
        });
        return res.json(selection);
    }

    let trackIds: string[] = [];
    let vibeSourceFeatures: any = null; // For vibe mode - store source track features

    switch (radioType) {
        case "liked":
            if (!userId) {
                return res.status(401).json({
                    error: "Authentication required for liked radio",
                });
            }

            const likedTracks = await prisma.likedTrack.findMany({
                where: {
                    userId,
                    track: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                    },
                },
                select: { trackId: true },
                orderBy: { likedAt: "desc" },
                take: limitNum,
            });
            trackIds = likedTracks.map((entry) => entry.trackId);
            logger.debug(
                `[Radio:liked] Loaded ${trackIds.length} liked tracks for user ${userId}`,
            );
            break;

        case "mood": {
            // Mood-based filtering using audio analysis features
            const moodValue = (radioValue || "").toLowerCase();
            const moodCondition = moodPoolCondition(moodValue);
            trackIds = await loadRadioIdCandidatePool(
                `mood:${moodValue}:${limitNum}`,
                async () => {
                    const moodTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT t.id FROM "Track" t
                    WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL} AND ${moodCondition}
                    ORDER BY random()
                    LIMIT ${limitNum * 4}
                `;
                    return moodTracks.map((track) => track.id);
                },
            );
            break;
        }

        case "artist":
        case "vibe": {
            try {
                const selection = await selectLibrarySeedRadio({
                    type: radioType,
                    value: radioValue ?? "",
                    limit: limitNum,
                    userId,
                });
                if ("tracks" in selection)
                    return res.json({ tracks: selection.tracks });
                trackIds = selection.trackIds;
                vibeSourceFeatures = selection.sourceFeatures ?? null;
            } catch (error) {
                if (error instanceof LibrarySeedRadioError)
                    return sendRouteError(res, error.status, error.message);
                throw error;
            }
            break;
        }

        case "playlist": {
            if (!radioValue) {
                return sendRouteError(
                    res,
                    400,
                    "Playlist ID required for playlist radio",
                );
            }

            let seedTrackIds: string[];

            if (radioValue === MY_LIKED_PLAYLIST_ID) {
                // My Liked pseudo-playlist — requires auth
                if (!userId) {
                    return sendRouteError(
                        res,
                        401,
                        "Authentication required for liked playlist radio",
                    );
                }
                const likedEntries = await prisma.likedTrack.findMany({
                    where: {
                        userId,
                        track: {
                            ...TRACK_VISIBLE_WHERE,
                            ...TRACK_BROWSE_WHERE,
                        },
                    },
                    select: { trackId: true },
                });
                seedTrackIds = likedEntries.map((e) => e.trackId);
                logger.debug(
                    `[Radio:playlist] Seeding from My Liked: ${seedTrackIds.length} tracks`,
                );
            } else {
                const playlist = await prisma.playlist.findUnique({
                    where: { id: radioValue },
                    select: { userId: true, isPublic: true },
                });
                if (!playlist) {
                    return sendRouteError(res, 404, "Playlist not found");
                }
                if (!playlist.isPublic && playlist.userId !== userId) {
                    return sendRouteError(
                        res,
                        403,
                        "Access denied to private playlist",
                    );
                }
                const items = await prisma.playlistItem.findMany({
                    where: {
                        playlistId: radioValue,
                        trackId: { not: null },
                        track: {
                            ...TRACK_VISIBLE_WHERE,
                            ...TRACK_BROWSE_WHERE,
                        },
                    },
                    select: { trackId: true },
                });
                seedTrackIds = items
                    .map((i) => i.trackId)
                    .filter((id): id is string => id !== null);
                logger.debug(
                    `[Radio:playlist] Seeding from playlist ${radioValue}: ${seedTrackIds.length} local tracks`,
                );
            }
            if (seedTrackIds.length === 0) {
                if (radioValue === MY_LIKED_PLAYLIST_ID)
                    return res.json({
                        tracks: await buildRemoteLikedRadio(userId!, limitNum),
                    });
                const tracks = await buildRemotePlaylistRadio(
                    radioValue,
                    limitNum,
                );
                return res.json({ tracks });
            }
            const playlistResult = await buildMultiTrackRadio(
                seedTrackIds,
                seedTrackIds,
                limitNum,
                userId,
            );
            trackIds = playlistResult.trackIds;
            break;
        }

        case "tracks": {
            // Arbitrary multi-track seed radio — comma-separated track IDs
            if (!radioValue) {
                return sendRouteError(
                    res,
                    400,
                    "Track IDs required for tracks radio",
                );
            }

            const inputTrackIds = radioValue
                .split(",")
                .map((id) => id.trim())
                .filter((id) => id.length > 0);

            if (inputTrackIds.length === 0) {
                trackIds = [];
                break;
            }

            logger.debug(
                `[Radio:tracks] Seeding from ${inputTrackIds.length} track IDs`,
            );

            const tracksResult = await buildMultiTrackRadio(
                inputTrackIds,
                inputTrackIds,
                limitNum,
                userId,
            );
            trackIds = tracksResult.trackIds;
            break;
        }

        case "all":
        default:
            // Random selection from all tracks in library
            trackIds = await loadRadioIdCandidatePool(
                `all:${limitNum}`,
                async () => {
                    const allTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT t.id FROM "Track" t
                    WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL}
                    ORDER BY random()
                    LIMIT ${limitNum * 4}
                `;
                    return allTracks.map((track) => track.id);
                },
            );
    }

    // Keep deterministic ordering for vibe (similarity-ranked) and liked (likedAt-ranked) queues.
    // Shuffle the source pool for all other radio modes.
    const preserveInputOrder =
        radioType === "vibe" ||
        radioType === "liked" ||
        radioType === "playlist" ||
        radioType === "tracks";
    // Artist radio already runs selectTracksWithArtistDiversity (the
    // reference cap implementation); every other generated pool goes
    // through the shared weighted allocator below (GH #46).
    const alreadyDiversified = radioType === "artist";
    const basePoolIds = preserveInputOrder
        ? trackIds
        : shuffleArray(trackIds).slice(0, Math.max(limitNum * 4, limitNum));
    let diversifiedPoolIds = basePoolIds;
    if (!preserveInputOrder && !alreadyDiversified && basePoolIds.length > 0) {
        const poolArtistRows = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...TRACK_BROWSE_WHERE,
                id: { in: basePoolIds },
            },
            select: { id: true, album: { select: { artistId: true } } },
        });
        const artistByTrackId = new Map(
            poolArtistRows.map((row) => [row.id, row.album?.artistId ?? ""]),
        );
        diversifiedPoolIds = allocateTracksWithArtistWeighting(
            basePoolIds,
            (trackId, index) =>
                artistByTrackId.get(trackId) || `unknown:${index}`,
            {
                targetCount: limitNum,
                alpha: config.generationDiversity.weightAlpha,
                ceilingShare: config.generationDiversity.shareCeiling,
            },
        );
        logger.debug(
            `[Radio:${radioType}] Artist-weighted selection: ${diversifiedPoolIds.length}/${basePoolIds.length} tracks (alpha=${config.generationDiversity.weightAlpha}, ceiling=${config.generationDiversity.shareCeiling})`,
        );
    }
    const selectedPoolIds = diversifiedPoolIds.slice(0, limitNum);
    const preferenceScoreMap =
        radioType === "liked"
            ? new Map<string, number>()
            : await buildTrackPreferenceScoreMapForUser(
                  userId,
                  selectedPoolIds,
              );
    const finalIds =
        preferenceScoreMap.size > 0
            ? applyTrackPreferenceOrderBias(selectedPoolIds, preferenceScoreMap)
            : selectedPoolIds;

    if (preferenceScoreMap.size > 0) {
        logger.debug(
            `[Radio:${radioType}] Applied light preference weighting using ${preferenceScoreMap.size} track preferences`,
        );
    }

    if (finalIds.length === 0) {
        return res.json({ tracks: [] });
    }

    // Fetch full track data (include all analysis fields for logging)
    const tracks = await prisma.track.findMany({
        where: {
            ...TRACK_VISIBLE_WHERE,
            ...TRACK_BROWSE_WHERE,
            id: { in: finalIds },
        },
        include: {
            album: {
                include: {
                    artist: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                },
            },
            trackGenres: {
                include: {
                    genre: { select: { name: true } },
                },
            },
        },
    });

    // Reorder tracks whenever we preserve input order since Prisma IN does not preserve ordering.
    let orderedTracks = tracks;
    if (preserveInputOrder) {
        const trackMap = new Map(tracks.map((t) => [t.id, t]));
        orderedTracks = finalIds
            .map((id) => trackMap.get(id))
            .filter((t): t is (typeof tracks)[0] => t !== undefined);
    }

    // === VIBE QUEUE LOGGING ===
    // Log detailed info for vibe matching analysis (using ordered tracks)
    if (radioType === "vibe" && vibeSourceFeatures) {
        logger.debug("\n" + "=".repeat(100));
        logger.debug("VIBE QUEUE ANALYSIS - Source Track");
        logger.debug("=".repeat(100));

        // Find source track for logging
        const srcTrack = await prisma.track.findUnique({
            where: {
                id: radioValue as string,
                ...TRACK_VISIBLE_WHERE,
                AND: [TRACK_BROWSE_WHERE],
            },
            include: {
                album: { include: { artist: { select: { name: true } } } },
                trackGenres: {
                    include: { genre: { select: { name: true } } },
                },
            },
        });

        if (srcTrack) {
            logger.debug(
                `SOURCE: "${srcTrack.title}" by ${srcTrack.album.artist.name}`,
            );
            logger.debug(`  Album: ${srcTrack.album.title}`);
            logger.debug(
                `  Analysis Mode: ${
                    (srcTrack as any).analysisMode || "unknown"
                }`,
            );
            logger.debug(
                `  BPM: ${srcTrack.bpm?.toFixed(1) || "N/A"} | Energy: ${
                    srcTrack.energy?.toFixed(2) || "N/A"
                } | Valence: ${srcTrack.valence?.toFixed(2) || "N/A"}`,
            );
            logger.debug(
                `  Danceability: ${
                    srcTrack.danceability?.toFixed(2) || "N/A"
                } | Arousal: ${
                    srcTrack.arousal?.toFixed(2) || "N/A"
                } | Key: ${srcTrack.keyScale || "N/A"}`,
            );
            logger.debug(
                `  ML Moods: Happy=${
                    (srcTrack as any).moodHappy?.toFixed(2) || "N/A"
                }, Sad=${
                    (srcTrack as any).moodSad?.toFixed(2) || "N/A"
                }, Relaxed=${
                    (srcTrack as any).moodRelaxed?.toFixed(2) || "N/A"
                }, Aggressive=${
                    (srcTrack as any).moodAggressive?.toFixed(2) || "N/A"
                }`,
            );
            logger.debug(
                `  Genres: ${
                    srcTrack.trackGenres
                        .map((tg) => tg.genre.name)
                        .join(", ") || "N/A"
                }`,
            );
            logger.debug(
                `  Last.fm Tags: ${
                    ((srcTrack as any).lastfmTags || []).join(", ") || "N/A"
                }`,
            );
            logger.debug(
                `  Mood Tags: ${
                    ((srcTrack as any).moodTags || []).join(", ") || "N/A"
                }`,
            );
        }

        logger.debug("\n" + "-".repeat(100));
        logger.debug(
            `VIBE QUEUE - ${orderedTracks.length} tracks (showing up to 50, SORTED BY MATCH SCORE)`,
        );
        logger.debug("-".repeat(100));
        logger.debug(
            `${"#".padEnd(3)} | ${"TRACK".padEnd(35)} | ${"ARTIST".padEnd(
                20,
            )} | ${"BPM".padEnd(6)} | ${"ENG".padEnd(5)} | ${"VAL".padEnd(
                5,
            )} | ${"H".padEnd(4)} | ${"S".padEnd(4)} | ${"R".padEnd(
                4,
            )} | ${"A".padEnd(4)} | MODE    | GENRES`,
        );
        logger.debug("-".repeat(100));

        orderedTracks.slice(0, 50).forEach((track, i) => {
            const t = track as any;
            const title = track.title.substring(0, 33).padEnd(35);
            const artist = track.album.artist.name.substring(0, 18).padEnd(20);
            const bpm = track.bpm
                ? track.bpm.toFixed(0).padEnd(6)
                : "N/A".padEnd(6);
            const energy =
                track.energy !== null
                    ? track.energy.toFixed(2).padEnd(5)
                    : "N/A".padEnd(5);
            const valence =
                track.valence !== null
                    ? track.valence.toFixed(2).padEnd(5)
                    : "N/A".padEnd(5);
            const happy =
                t.moodHappy !== null
                    ? t.moodHappy.toFixed(2).padEnd(4)
                    : "N/A".padEnd(4);
            const sad =
                t.moodSad !== null
                    ? t.moodSad.toFixed(2).padEnd(4)
                    : "N/A".padEnd(4);
            const relaxed =
                t.moodRelaxed !== null
                    ? t.moodRelaxed.toFixed(2).padEnd(4)
                    : "N/A".padEnd(4);
            const aggressive =
                t.moodAggressive !== null
                    ? t.moodAggressive.toFixed(2).padEnd(4)
                    : "N/A".padEnd(4);
            const mode = (t.analysisMode || "std").substring(0, 7).padEnd(8);
            const genres = track.trackGenres
                .slice(0, 3)
                .map((tg) => tg.genre.name)
                .join(", ");

            logger.debug(
                `${String(i + 1).padEnd(
                    3,
                )} | ${title} | ${artist} | ${bpm} | ${energy} | ${valence} | ${happy} | ${sad} | ${relaxed} | ${aggressive} | ${mode} | ${genres}`,
            );
        });

        if (orderedTracks.length > 50) {
            logger.debug(`... and ${orderedTracks.length - 50} more tracks`);
        }

        logger.debug("=".repeat(100) + "\n");
    }

    const transformedTracks = orderedTracks.map((track) =>
        transformRadioTrack(track, vibeSourceFeatures),
    );

    // Keep deterministic ordering for vibe/liked queues. Shuffle all other radio queues.
    const finalTracks = preserveInputOrder
        ? transformedTracks
        : separateArtists(
              shuffleArray(transformedTracks),
              (t: any) => t.artist?.id ?? `unknown:${t.id}`,
          );

    // Include source features if this was a vibe request
    const response: any = { tracks: finalTracks };
    if (vibeSourceFeatures) {
        response.sourceFeatures = vibeSourceFeatures;
    }

    res.json(response);
}

radioRouter.get("/radio", asyncHandler(handleGetRadio));
