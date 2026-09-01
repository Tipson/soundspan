import { asyncHandler } from "../middleware/asyncHandler";
import {
    musicBrainzService,
    type MusicBrainzArtistSearchResult,
} from "../services/musicbrainz";
import { logger } from "../utils/logger";
import { sendInternalRouteError } from "../utils/routeErrorResponse";

/** Authenticated MusicBrainz artist autocomplete used by taste and metadata flows. */
export const searchMusicBrainzArtistsHandler = asyncHandler(
    async (req, res) => {
        try {
            const query = String(req.query.q || "")
                .trim()
                .normalize("NFC");
            if (query.length < 2) {
                return res
                    .status(400)
                    .json({ error: "Query must be at least 2 characters" });
            }
            if (query.length > 80) {
                return res
                    .status(400)
                    .json({ error: "Query must be at most 80 characters" });
            }

            const results = await musicBrainzService.searchArtist(query, 10);
            const artists = results.map(
                (artist: MusicBrainzArtistSearchResult) => ({
                    mbid: artist.id,
                    name: artist.name,
                    disambiguation: artist.disambiguation || null,
                    country: artist.country || null,
                    type: artist.type || null,
                    score:
                        typeof artist.score === "number"
                            ? artist.score
                            : Number.parseInt(artist.score || "0", 10),
                }),
            );

            res.json({ artists });
        } catch (error: unknown) {
            logger.error("MusicBrainz artist search error:", error);
            sendInternalRouteError(res, "Search failed");
        }
    },
);
