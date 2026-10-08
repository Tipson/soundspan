import { prisma, type Prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getMergedGenres } from "../utils/metadataOverrides";
import { shuffleArray } from "../utils/shuffle";
import {
    LOCAL_AUDIO_ANALYSIS_TRACK_WHERE,
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../utils/librarySorting";
import { applyTrackPreferenceSimilarityBias } from "./trackPreference";
import { buildRemoteArtistRadio } from "./playlistRemoteRadio";
import {
    getRadioArtistCapForLimit,
    getRelaxedRadioArtistCapForLimit,
    selectTracksWithArtistDiversity,
} from "./libraryRadioBuilder";
import { loadVibeRadioCandidateIds } from "./libraryRadioCache";
import { LibrarySeedRadioError } from "./librarySeedRadioError";
export { LibrarySeedRadioError } from "./librarySeedRadioError";
import { hasReliableEnhancedAnalysis } from "../utils/libraryRadioPredicates";

const VIBE_FALLBACK_QUERY_LIMIT = 400;

/** Bounded random window; a count/read race may return fewer rows without retrying. */
async function loadShuffledVibeFallbackIds(
    where: Prisma.TrackWhereInput,
    limit: number,
): Promise<string[]> {
    const count = await prisma.track.count({ where });
    const target = Math.min(count, Math.max(0, Math.floor(limit)));
    if (target === 0) return [];
    const skip = count > target ? Math.floor(Math.random() * count) : 0;
    const rows = await prisma.track.findMany({
        where,
        select: { id: true },
        orderBy: { id: "asc" },
        skip,
        take: target,
    });
    if (rows.length < target && skip > 0) {
        rows.push(
            ...(await prisma.track.findMany({
                where,
                select: { id: true },
                orderBy: { id: "asc" },
                skip: 0,
                take: target - rows.length,
            })),
        );
    }
    return shuffleArray([...new Set(rows.map((row) => row.id))]).slice(
        0,
        target,
    );
}

/** Caller-owned policy can reject local candidates before seed-radio quotas and fallbacks. */
export interface LibrarySeedRadioInput {
    type: "artist" | "vibe";
    value: string;
    limit: number;
    userId?: string;
    admitTrackIds?: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
    /** Reports provider seed failures while retaining usable remote-artist results. */
    onRemotePartialFailure?: () => void;
    /** Defaults to the legacy random refill; automatic continuation can opt out. */
    allowRandomFallback?: boolean;
}

/** Local selection keeps IDs for shared hydration; catalog-only artists retain remote radio. */
export type LibrarySeedRadioSelection =
    | { trackIds: string[]; sourceFeatures?: unknown }
    | { tracks: unknown[] };

/** Select the existing artist/vibe pool without an internal HTTP request or signal writes. */
export async function selectLibrarySeedRadio(
    input: LibrarySeedRadioInput,
): Promise<LibrarySeedRadioSelection> {
    const { type: radioType, value: radioValue, limit: limitNum } = input;
    let trackIds: string[] = [];
    let vibeSourceFeatures: unknown = null;
    const admitIds = async (ids: readonly string[]): Promise<string[]> => {
        if (!input.admitTrackIds || ids.length === 0) return [...ids];
        const allowed = await input.admitTrackIds(ids);
        return ids.filter((id) => allowed.has(id));
    };
    const admitRows = async <T extends { id: string }>(
        rows: T[],
    ): Promise<T[]> => {
        if (!input.admitTrackIds || rows.length === 0) return rows;
        const allowed = await input.admitTrackIds(rows.map((row) => row.id));
        return rows.filter((row) => allowed.has(row.id));
    };

    switch (radioType) {
        case "artist":
            // Artist Radio - plays tracks from the artist + similar artists in library
            // Uses hybrid approach: Last.fm similarity (filtered to library) + genre matching + vibe boost
            const artistId = radioValue;
            if (!artistId) {
                throw new LibrarySeedRadioError(
                    400,
                    "Artist ID required for artist radio",
                );
            }

            logger.debug(
                `[Radio:artist] Starting artist radio for: ${artistId}`,
            );

            // 1. Prefer local audio; catalog artist rows may have no local files.
            const artistTracks = await prisma.track.findMany({
                where: {
                    ...TRACK_VISIBLE_WHERE,
                    ...TRACK_BROWSE_WHERE,
                    ...LOCAL_AUDIO_ANALYSIS_TRACK_WHERE,
                    album: { ...TRACK_VISIBLE_WHERE.album, artistId },
                },
                select: {
                    id: true,
                    bpm: true,
                    energy: true,
                    valence: true,
                    danceability: true,
                },
            });
            logger.debug(
                `[Radio:artist] Found ${artistTracks.length} tracks from artist`,
            );

            if (artistTracks.length === 0) {
                const artist = await prisma.artist.findUnique({
                    where: { id: artistId },
                    select: { name: true },
                });
                return {
                    tracks: artist?.name
                        ? input.onRemotePartialFailure
                            ? await buildRemoteArtistRadio(
                                  artist.name,
                                  limitNum,
                                  input.onRemotePartialFailure,
                              )
                            : await buildRemoteArtistRadio(
                                  artist.name,
                                  limitNum,
                              )
                        : [],
                };
            }

            // Calculate artist's average "vibe" for later matching
            const analyzedTracks = artistTracks.filter(
                (t) => t.bpm || t.energy || t.valence,
            );
            const avgVibe =
                analyzedTracks.length > 0
                    ? {
                          bpm:
                              analyzedTracks.reduce(
                                  (sum, t) => sum + (t.bpm || 0),
                                  0,
                              ) / analyzedTracks.length,
                          energy:
                              analyzedTracks.reduce(
                                  (sum, t) => sum + (t.energy || 0),
                                  0,
                              ) / analyzedTracks.length,
                          valence:
                              analyzedTracks.reduce(
                                  (sum, t) => sum + (t.valence || 0),
                                  0,
                              ) / analyzedTracks.length,
                          danceability:
                              analyzedTracks.reduce(
                                  (sum, t) => sum + (t.danceability || 0),
                                  0,
                              ) / analyzedTracks.length,
                      }
                    : null;
            logger.debug(`[Radio:artist] Artist vibe:`, avgVibe);

            // 2. Get library artist IDs (artists user actually owns)
            const ownedArtists = await prisma.ownedAlbum.findMany({
                select: { artistId: true },
                distinct: ["artistId"],
            });
            const libraryArtistIds = new Set(
                ownedArtists.map((o) => o.artistId),
            );
            libraryArtistIds.delete(artistId); // Exclude the current artist
            logger.debug(
                `[Radio:artist] Library has ${libraryArtistIds.size} other artists`,
            );

            // 3. Try Last.fm similar artists, filtered to library
            const similarInLibrary = await prisma.similarArtist.findMany({
                where: {
                    fromArtistId: artistId,
                    toArtistId: { in: Array.from(libraryArtistIds) },
                },
                orderBy: { weight: "desc" },
                take: 15,
            });
            let similarArtistIds = similarInLibrary.map((s) => s.toArtistId);
            logger.debug(
                `[Radio:artist] Found ${similarArtistIds.length} Last.fm similar artists in library`,
            );

            // 4. Fallback: genre matching if not enough similar artists
            if (similarArtistIds.length < 5 && libraryArtistIds.size > 0) {
                const artist = await prisma.artist.findUnique({
                    where: { id: artistId },
                    select: { genres: true, userGenres: true },
                });
                const artistGenres = getMergedGenres(artist || {});

                if (artistGenres.length > 0) {
                    // Find library artists with overlapping genres
                    const genreMatchArtists = await prisma.artist.findMany({
                        where: {
                            id: { in: Array.from(libraryArtistIds) },
                        },
                        select: {
                            id: true,
                            genres: true,
                            userGenres: true,
                        },
                    });

                    // Score artists by genre overlap using merged genres
                    const scoredArtists = genreMatchArtists
                        .map((a) => {
                            const theirGenres = getMergedGenres(a);
                            const overlap = artistGenres.filter((g) =>
                                theirGenres.some(
                                    (tg) =>
                                        tg
                                            .toLowerCase()
                                            .includes(g.toLowerCase()) ||
                                        g
                                            .toLowerCase()
                                            .includes(tg.toLowerCase()),
                                ),
                            ).length;
                            return { id: a.id, score: overlap };
                        })
                        .filter((a) => a.score > 0)
                        .sort((a, b) => b.score - a.score)
                        .slice(0, 10);

                    const genreArtistIds = scoredArtists.map((a) => a.id);
                    similarArtistIds = [
                        ...new Set([...similarArtistIds, ...genreArtistIds]),
                    ];
                    logger.debug(
                        `[Radio:artist] After genre matching: ${similarArtistIds.length} similar artists`,
                    );
                }
            }

            // 5. Get tracks from similar library artists
            let similarTracks: {
                id: string;
                artistId: string;
                bpm: number | null;
                energy: number | null;
                valence: number | null;
                danceability: number | null;
                vibeScore?: number;
            }[] = [];
            if (similarArtistIds.length > 0) {
                const similarTrackRows = await prisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        ...LOCAL_AUDIO_ANALYSIS_TRACK_WHERE,
                        album: {
                            ...TRACK_VISIBLE_WHERE.album,
                            artistId: { in: similarArtistIds },
                        },
                    },
                    select: {
                        id: true,
                        bpm: true,
                        energy: true,
                        valence: true,
                        danceability: true,
                        album: {
                            select: {
                                artistId: true,
                            },
                        },
                    },
                });
                similarTracks = similarTrackRows.map((track) => ({
                    id: track.id,
                    artistId: track.album.artistId,
                    bpm: track.bpm,
                    energy: track.energy,
                    valence: track.valence,
                    danceability: track.danceability,
                }));
                logger.debug(
                    `[Radio:artist] Found ${similarTracks.length} tracks from similar artists`,
                );
            }

            // 6. Apply vibe boost if we have audio analysis data
            if (avgVibe && similarTracks.length > 0) {
                // Score each similar track by how close its vibe is to the artist's average
                similarTracks = similarTracks
                    .map((t) => {
                        if (!t.bpm && !t.energy && !t.valence)
                            return { ...t, vibeScore: 0.5 };

                        let score = 0;
                        let factors = 0;

                        if (t.bpm && avgVibe.bpm) {
                            // BPM within 20 = good match
                            const bpmDiff = Math.abs(t.bpm - avgVibe.bpm);
                            score += Math.max(0, 1 - bpmDiff / 40);
                            factors++;
                        }
                        if (t.energy !== null && avgVibe.energy) {
                            score +=
                                1 - Math.abs((t.energy || 0) - avgVibe.energy);
                            factors++;
                        }
                        if (t.valence !== null && avgVibe.valence) {
                            score +=
                                1 -
                                Math.abs((t.valence || 0) - avgVibe.valence);
                            factors++;
                        }
                        if (t.danceability !== null && avgVibe.danceability) {
                            score +=
                                1 -
                                Math.abs(
                                    (t.danceability || 0) -
                                        avgVibe.danceability,
                                );
                            factors++;
                        }

                        return {
                            ...t,
                            vibeScore: factors > 0 ? score / factors : 0.5,
                        };
                    })
                    .sort(
                        (a, b) => (b as any).vibeScore - (a as any).vibeScore,
                    );

                logger.debug(
                    `[Radio:artist] Applied vibe boost, top score: ${(
                        similarTracks[0] as any
                    )?.vibeScore?.toFixed(2)}`,
                );
            }

            const admittedArtistTracks = await admitRows(artistTracks);
            similarTracks = await admitRows(similarTracks);

            // 7. Mix: ~40% original artist, ~60% similar (vibe-boosted)
            const originalCount = Math.min(
                Math.ceil(limitNum * 0.4),
                admittedArtistTracks.length,
            );
            const similarCount = Math.min(
                limitNum - originalCount,
                similarTracks.length,
            );
            const strictSimilarArtistCap = getRadioArtistCapForLimit(limitNum);
            const relaxedSimilarArtistCap =
                getRelaxedRadioArtistCapForLimit(limitNum);

            const selectedOriginal = shuffleArray(admittedArtistTracks).slice(
                0,
                originalCount,
            );
            // Prioritize top vibe matches, but cap per-similar-artist to avoid overrepresentation.
            const prioritizedSimilarPool = shuffleArray(
                similarTracks.slice(
                    0,
                    Math.max(similarCount * 3, similarCount),
                ),
            );
            const remainingSimilarPool = similarTracks.slice(
                Math.max(similarCount * 3, similarCount),
            );
            const selectedSimilar = selectTracksWithArtistDiversity(
                [...prioritizedSimilarPool, ...remainingSimilarPool],
                similarCount,
                strictSimilarArtistCap,
                relaxedSimilarArtistCap,
            );
            const uniqueSimilarArtists = new Set(
                selectedSimilar.map((track) => track.artistId),
            ).size;
            logger.debug(
                `[Radio:artist] Similar artist diversity cap strict=${strictSimilarArtistCap}, relaxed=${relaxedSimilarArtistCap}, unique artists=${uniqueSimilarArtists}`,
            );

            trackIds = [...selectedOriginal, ...selectedSimilar].map(
                (t) => t.id,
            );
            logger.debug(
                `[Radio:artist] Final mix: ${selectedOriginal.length} original + ${selectedSimilar.length} similar = ${trackIds.length} tracks`,
            );
            break;

        case "vibe":
            // Vibe Match - finds tracks that sound like the given track
            // Pure audio feature matching with graceful fallbacks
            const sourceTrackId = radioValue;
            if (!sourceTrackId) {
                throw new LibrarySeedRadioError(
                    400,
                    "Track ID required for vibe matching",
                );
            }

            logger.debug(
                `[Radio:vibe] Starting vibe match for track: ${sourceTrackId}`,
            );

            // 1. Get the source track's audio features (including Enhanced mode fields)
            const sourceTrack = (await prisma.track.findUnique({
                where: {
                    id: sourceTrackId,
                    ...TRACK_VISIBLE_WHERE,
                    AND: [TRACK_BROWSE_WHERE],
                },
                include: {
                    album: {
                        select: {
                            artistId: true,
                            genres: true,
                            artist: { select: { id: true, name: true } },
                        },
                    },
                },
            })) as any; // Cast to any to include all Track fields

            if (!sourceTrack) {
                throw new LibrarySeedRadioError(404, "Track not found");
            }

            const sourceHasReliableEnhancedAnalysis =
                hasReliableEnhancedAnalysis(
                    sourceTrack.analysisMode,
                    sourceTrack.analysisVersion,
                );

            logger.debug(
                `[Radio:vibe] Source: "${sourceTrack.title}" by ${sourceTrack.album.artist.name}`,
            );
            logger.debug(
                `[Radio:vibe] Analysis mode: ${
                    sourceHasReliableEnhancedAnalysis ? "ENHANCED" : "STANDARD"
                }`,
            );
            logger.debug(
                `[Radio:vibe] Source features: BPM=${sourceTrack.bpm}, Energy=${sourceTrack.energy}, Valence=${sourceTrack.valence}`,
            );
            if (sourceHasReliableEnhancedAnalysis) {
                logger.debug(
                    `[Radio:vibe] ML Moods: Happy=${sourceTrack.moodHappy}, Sad=${sourceTrack.moodSad}, Relaxed=${sourceTrack.moodRelaxed}, Aggressive=${sourceTrack.moodAggressive}, Party=${sourceTrack.moodParty}, Acoustic=${sourceTrack.moodAcoustic}, Electronic=${sourceTrack.moodElectronic}`,
                );
            }

            // Store source features for frontend visualization
            vibeSourceFeatures = {
                bpm: sourceTrack.bpm,
                energy: sourceTrack.energy,
                valence: sourceTrack.valence,
                arousal: sourceTrack.arousal,
                danceability: sourceTrack.danceability,
                keyScale: sourceTrack.keyScale,
                instrumentalness: sourceTrack.instrumentalness,
                // Enhanced mode features (all 7 ML mood predictions)
                moodHappy: sourceTrack.moodHappy,
                moodSad: sourceTrack.moodSad,
                moodRelaxed: sourceTrack.moodRelaxed,
                moodAggressive: sourceTrack.moodAggressive,
                moodParty: sourceTrack.moodParty,
                moodAcoustic: sourceTrack.moodAcoustic,
                moodElectronic: sourceTrack.moodElectronic,
                analysisMode: sourceHasReliableEnhancedAnalysis
                    ? "enhanced"
                    : "standard",
            };

            let vibeMatchedIds: string[] = [];
            const sourceArtistId = sourceTrack.album.artistId;

            // 2. Use embedding similarity to bound the feature re-ranking pool.
            const annCandidateIds =
                await loadVibeRadioCandidateIds(sourceTrackId);
            if (annCandidateIds.length > 0) {
                // Hydrate only the bounded embedding-ranked pool for the existing
                // feature and tag re-ranking step.
                const analyzedTracks = await prisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        id: { in: annCandidateIds },
                        analysisStatus: "completed",
                    },
                    select: {
                        id: true,
                        bpm: true,
                        energy: true,
                        valence: true,
                        arousal: true,
                        danceability: true,
                        keyScale: true,
                        moodTags: true,
                        lastfmTags: true,
                        essentiaGenres: true,
                        instrumentalness: true,
                        // Enhanced mode fields (all 7 ML mood predictions)
                        moodHappy: true,
                        moodSad: true,
                        moodRelaxed: true,
                        moodAggressive: true,
                        moodParty: true,
                        moodAcoustic: true,
                        moodElectronic: true,
                        danceabilityMl: true,
                        analysisMode: true,
                        analysisVersion: true,
                    },
                });

                logger.debug(
                    `[Radio:vibe] Found ${analyzedTracks.length} analyzed tracks to compare`,
                );

                if (analyzedTracks.length > 0) {
                    // === COSINE SIMILARITY SCORING ===
                    // Industry-standard approach: build feature vectors, compute cosine similarity
                    // Uses ALL 13 features for comprehensive matching

                    // Enhanced valence: mode/tonality + mood + audio features
                    const calculateEnhancedValence = (track: any): number => {
                        const happy = track.moodHappy ?? 0.5;
                        const sad = track.moodSad ?? 0.5;
                        const party = (track as any).moodParty ?? 0.5;
                        const isMajor = track.keyScale === "major";
                        const isMinor = track.keyScale === "minor";
                        const modeValence = isMajor ? 0.3 : isMinor ? -0.2 : 0;
                        const moodValence =
                            happy * 0.35 + party * 0.25 + (1 - sad) * 0.2;
                        const audioValence =
                            (track.energy ?? 0.5) * 0.1 +
                            (track.danceabilityMl ??
                                track.danceability ??
                                0.5) *
                                0.1;

                        return Math.max(
                            0,
                            Math.min(
                                1,
                                moodValence + modeValence + audioValence,
                            ),
                        );
                    };

                    // Enhanced arousal: mood + energy + tempo (avoids unreliable "electronic" mood)
                    const calculateEnhancedArousal = (track: any): number => {
                        const aggressive = track.moodAggressive ?? 0.5;
                        const party = (track as any).moodParty ?? 0.5;
                        const relaxed = track.moodRelaxed ?? 0.5;
                        const acoustic = (track as any).moodAcoustic ?? 0.5;
                        const energy = track.energy ?? 0.5;
                        const bpm = track.bpm ?? 120;
                        const moodArousal = aggressive * 0.3 + party * 0.2;
                        const energyArousal = energy * 0.25;
                        const tempoArousal =
                            Math.max(0, Math.min(1, (bpm - 60) / 120)) * 0.15;
                        const calmReduction =
                            (1 - relaxed) * 0.05 + (1 - acoustic) * 0.05;

                        return Math.max(
                            0,
                            Math.min(
                                1,
                                moodArousal +
                                    energyArousal +
                                    tempoArousal +
                                    calmReduction,
                            ),
                        );
                    };

                    // OOD detection using Energy-based scoring
                    const detectOOD = (track: any): boolean => {
                        const coreMoods = [
                            track.moodHappy ?? 0.5,
                            track.moodSad ?? 0.5,
                            track.moodRelaxed ?? 0.5,
                            track.moodAggressive ?? 0.5,
                        ];

                        const minMood = Math.min(...coreMoods);
                        const maxMood = Math.max(...coreMoods);

                        // Enhanced OOD detection based on research
                        // Flag if all core moods are high (>0.7) with low variance, OR if all are very neutral (~0.5)
                        const allHigh =
                            minMood > 0.7 && maxMood - minMood < 0.3;
                        const allNeutral =
                            Math.abs(maxMood - 0.5) < 0.15 &&
                            Math.abs(minMood - 0.5) < 0.15;

                        return allHigh || allNeutral;
                    };

                    // Octave-aware BPM distance calculation
                    const octaveAwareBPMDistance = (
                        bpm1: number,
                        bpm2: number,
                    ): number => {
                        if (!bpm1 || !bpm2) return 0;

                        // Normalize to standard octave range (77-154 BPM)
                        const normalizeToOctave = (bpm: number): number => {
                            while (bpm < 77) bpm *= 2;
                            while (bpm > 154) bpm /= 2;
                            return bpm;
                        };

                        const norm1 = normalizeToOctave(bpm1);
                        const norm2 = normalizeToOctave(bpm2);

                        // Calculate distance on logarithmic scale for harmonic equivalence
                        const logDistance = Math.abs(
                            Math.log2(norm1) - Math.log2(norm2),
                        );
                        return Math.min(logDistance, 1); // Cap at 1 for similarity calculation
                    };

                    // Helper: Build enhanced weighted feature vector from track
                    const buildFeatureVector = (track: any): number[] => {
                        const trackHasReliableEnhancedAnalysis =
                            hasReliableEnhancedAnalysis(
                                track.analysisMode,
                                track.analysisVersion,
                            );
                        const isOOD =
                            trackHasReliableEnhancedAnalysis &&
                            detectOOD(track);

                        // Get mood values with OOD normalization
                        const getMoodValue = (
                            value: number | null,
                            defaultValue: number,
                        ): number => {
                            if (!value) return defaultValue;
                            if (!isOOD) return value;
                            // Normalize OOD predictions to spread them out (0.2-0.8 range)
                            return (
                                0.2 + Math.max(0, Math.min(0.6, value - 0.2))
                            );
                        };

                        // Use enhanced valence/arousal calculations
                        const enhancedValence = trackHasReliableEnhancedAnalysis
                            ? calculateEnhancedValence(track)
                            : (track.valence ?? 0.5);
                        const enhancedArousal = trackHasReliableEnhancedAnalysis
                            ? calculateEnhancedArousal(track)
                            : (track.arousal ?? track.energy ?? 0.5);

                        return [
                            // ML Mood predictions (7 features) - enhanced weighting and OOD handling
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? track.moodHappy
                                    : null,
                                0.5,
                            ) * 1.3, // 1.3x weight for semantic features
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? track.moodSad
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? track.moodRelaxed
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? track.moodAggressive
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? (track as any).moodParty
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? (track as any).moodAcoustic
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? (track as any).moodElectronic
                                    : null,
                                0.5,
                            ) * 1.3,
                            // Audio features (5 features) - standard weight
                            track.energy ?? 0.5,
                            enhancedArousal, // Use enhanced arousal
                            track.danceabilityMl ?? track.danceability ?? 0.5,
                            track.instrumentalness ?? 0.5,
                            // Octave-aware BPM normalized to 0-1
                            1 - octaveAwareBPMDistance(track.bpm ?? 120, 120), // Similarity to reference tempo
                            // Enhanced key mode with valence consideration
                            enhancedValence, // Use enhanced valence instead of binary key
                        ];
                    };

                    // Helper: Compute cosine similarity between two vectors
                    const cosineSimilarity = (
                        a: number[],
                        b: number[],
                    ): number => {
                        let dot = 0,
                            magA = 0,
                            magB = 0;
                        for (let i = 0; i < a.length; i++) {
                            dot += a[i] * b[i];
                            magA += a[i] * a[i];
                            magB += b[i] * b[i];
                        }
                        if (magA === 0 || magB === 0) return 0;
                        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
                    };

                    // Helper: Compute tag overlap bonus
                    const computeTagBonus = (
                        sourceTags: string[],
                        sourceGenres: string[],
                        trackTags: string[],
                        trackGenres: string[],
                    ): number => {
                        const sourceSet = new Set(
                            [...sourceTags, ...sourceGenres].map((t) =>
                                t.toLowerCase(),
                            ),
                        );
                        const trackSet = new Set(
                            [...trackTags, ...trackGenres].map((t) =>
                                t.toLowerCase(),
                            ),
                        );
                        if (sourceSet.size === 0 || trackSet.size === 0)
                            return 0;
                        const overlap = [...sourceSet].filter((tag) =>
                            trackSet.has(tag),
                        ).length;
                        // Max 5% bonus for tag overlap
                        return Math.min(0.05, overlap * 0.01);
                    };

                    // Build source feature vector once
                    const sourceVector = buildFeatureVector(sourceTrack);
                    const vibePreferenceScores = new Map<string, number>();

                    // Check if source track has Enhanced mode data
                    const sourceUsesEnhancedFeatures =
                        sourceHasReliableEnhancedAnalysis;

                    const scored = analyzedTracks.map((t) => {
                        const targetUsesEnhancedFeatures =
                            hasReliableEnhancedAnalysis(
                                t.analysisMode,
                                t.analysisVersion,
                            );
                        const useEnhanced =
                            sourceUsesEnhancedFeatures &&
                            targetUsesEnhancedFeatures;

                        // Build target feature vector
                        const targetVector = buildFeatureVector(t as any);

                        // Compute base cosine similarity
                        let score = cosineSimilarity(
                            sourceVector,
                            targetVector,
                        );

                        // Add tag/genre overlap bonus (max 5%)
                        const tagBonus = computeTagBonus(
                            sourceTrack.lastfmTags || [],
                            sourceTrack.essentiaGenres || [],
                            t.lastfmTags || [],
                            t.essentiaGenres || [],
                        );

                        // Final score: 95% cosine similarity + 5% tag bonus,
                        // plus light thumbs preference weighting.
                        const finalScore = Math.max(
                            0,
                            Math.min(
                                1,
                                applyTrackPreferenceSimilarityBias(
                                    score * 0.95 + tagBonus,
                                    vibePreferenceScores.get(t.id) ?? 0,
                                ),
                            ),
                        );

                        return {
                            id: t.id,
                            score: finalScore,
                            enhanced: useEnhanced,
                        };
                    });

                    // Filter to good matches and sort by score
                    // Use lower threshold (40%) for Enhanced mode since it's more precise
                    const minThreshold = sourceHasReliableEnhancedAnalysis
                        ? 0.4
                        : 0.5;
                    const goodMatches = scored
                        .filter((t) => t.score > minThreshold)
                        .sort((a, b) => b.score - a.score);

                    vibeMatchedIds = await admitIds(
                        goodMatches.map((t) => t.id),
                    );
                    const enhancedCount = goodMatches.filter(
                        (t) => t.enhanced,
                    ).length;
                    logger.debug(
                        `[Radio:vibe] Audio matching found ${
                            vibeMatchedIds.length
                        } tracks (>${minThreshold * 100}% similarity)`,
                    );
                    logger.debug(
                        `[Radio:vibe] Enhanced matches: ${enhancedCount}, Standard matches: ${
                            goodMatches.length - enhancedCount
                        }`,
                    );
                    if (vibePreferenceScores.size > 0) {
                        logger.debug(
                            `[Radio:vibe] Applied light preference weighting to ${vibePreferenceScores.size} analyzed candidates`,
                        );
                    }

                    if (goodMatches.length > 0) {
                        logger.debug(
                            `[Radio:vibe] Top match score: ${goodMatches[0].score.toFixed(
                                2,
                            )} (${
                                goodMatches[0].enhanced
                                    ? "enhanced"
                                    : "standard"
                            })`,
                        );
                    }
                }
            }

            if (vibeMatchedIds.length < limitNum) {
                const artistTracks = await prisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        album: { artistId: sourceArtistId },
                        id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                    },
                    select: { id: true },
                    orderBy: { id: "asc" },
                    take: VIBE_FALLBACK_QUERY_LIMIT,
                });
                const newIds = await admitIds(artistTracks.map((t) => t.id));
                vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                logger.debug(
                    `[Radio:vibe] Fallback A (same artist): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
                );
            }
            if (vibeMatchedIds.length < limitNum) {
                const ownedArtistIds = await prisma.ownedAlbum.findMany({
                    select: { artistId: true },
                    distinct: ["artistId"],
                    orderBy: { artistId: "asc" },
                    take: VIBE_FALLBACK_QUERY_LIMIT,
                });
                const libraryArtistSet = new Set(
                    ownedArtistIds.map((o) => o.artistId),
                );
                libraryArtistSet.delete(sourceArtistId);
                const similarArtists = await prisma.similarArtist.findMany({
                    where: {
                        fromArtistId: sourceArtistId,
                        toArtistId: { in: Array.from(libraryArtistSet) },
                    },
                    select: { toArtistId: true },
                    orderBy: [{ weight: "desc" }, { toArtistId: "asc" }],
                    take: 10,
                });
                if (similarArtists.length > 0) {
                    const similarArtistTracks = await prisma.track.findMany({
                        where: {
                            ...TRACK_VISIBLE_WHERE,
                            ...TRACK_BROWSE_WHERE,
                            album: {
                                artistId: {
                                    in: similarArtists.map((s) => s.toArtistId),
                                },
                            },
                            id: {
                                notIn: [sourceTrackId, ...vibeMatchedIds],
                            },
                        },
                        select: { id: true },
                        orderBy: { id: "asc" },
                        take: VIBE_FALLBACK_QUERY_LIMIT,
                    });
                    const newIds = await admitIds(
                        similarArtistTracks.map((t) => t.id),
                    );
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback B (similar artists): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
                    );
                }
            }
            const sourceGenres = (sourceTrack.album.genres as string[]) || [];
            if (vibeMatchedIds.length < limitNum && sourceGenres.length > 0) {
                // Search using the TrackGenre relation for better accuracy.
                const genreCandidateLimit = input.admitTrackIds
                    ? VIBE_FALLBACK_QUERY_LIMIT
                    : limitNum;
                const genreIds = await loadShuffledVibeFallbackIds(
                    {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        trackGenres: {
                            some: {
                                genre: {
                                    OR: sourceGenres.map((genre) => ({
                                        name: {
                                            equals: genre,
                                            mode: "insensitive",
                                        },
                                    })),
                                },
                            },
                        },
                    },
                    genreCandidateLimit,
                );
                const newIds = await admitIds(genreIds);
                vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                logger.debug(
                    `[Radio:vibe] Fallback C (same genre): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
                );
            }

            if (
                vibeMatchedIds.length < limitNum &&
                input.allowRandomFallback !== false
            ) {
                const remainingLimit = limitNum - vibeMatchedIds.length;
                const randomCandidateLimit = input.admitTrackIds
                    ? VIBE_FALLBACK_QUERY_LIMIT
                    : remainingLimit;
                const randomIds = await loadShuffledVibeFallbackIds(
                    {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                    },
                    randomCandidateLimit,
                );
                const newIds = await admitIds(randomIds);
                vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                logger.debug(
                    `[Radio:vibe] Fallback D (random): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
                );
            }

            trackIds = vibeMatchedIds;
            logger.debug(
                `[Radio:vibe] Final vibe queue: ${trackIds.length} tracks`,
            );
            break;
    }
    return {
        trackIds: trackIds.slice(0, limitNum),
        ...(vibeSourceFeatures ? { sourceFeatures: vibeSourceFeatures } : {}),
    };
}
