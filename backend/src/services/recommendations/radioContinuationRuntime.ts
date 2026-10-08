import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import {
    selectLibrarySeedRadio,
    LibrarySeedRadioError,
} from "../librarySeedRadio";
import {
    buildRemoteArtistRadio,
    buildRemoteTrackRadio,
} from "../playlistRemoteRadio";
import {
    loadLibraryRepeatExclusions,
    loadYouTubeRepeatExclusions,
    loadSuppressedYouTubeArtists,
    loadDislikedYouTubeIds,
    loadRecentlyViewedCanonicalKeys,
} from "../personalizedTrackPreferences";
import {
    findMappedCanonicalCandidates,
    providerTrackIdentityToCandidate,
} from "./canonicalIdentity";
import { recommendationFeatureStore } from "./featureStore";
import {
    createRadioContinuationLoader,
    type RadioContinuationLoaderDependencies,
} from "./radioContinuation";
import type { RecommendationCandidate } from "./types";

const log = logger.child("RadioContinuation");

async function readOr<T>(
    source: string,
    degraded: Set<string>,
    fallback: T,
    read: () => Promise<T>,
): Promise<T> {
    try {
        return await read();
    } catch {
        degraded.add(source);
        log.warn("Radio preference reader unavailable", { source });
        return fallback;
    }
}

const loadLibraryTracks: RadioContinuationLoaderDependencies["loadLibraryTracks"] =
    async (ids) => {
        const result: unknown[] = [];
        for (let offset = 0; offset < ids.length; offset += 500) {
            const rows = await prisma.track.findMany({
                where: {
                    ...TRACK_VISIBLE_WHERE,
                    ...TRACK_BROWSE_WHERE,
                    id: { in: [...ids.slice(offset, offset + 500)] },
                },
                select: {
                    id: true,
                    title: true,
                    duration: true,
                    trackNo: true,
                    origin: true,
                    filePath: true,
                    album: {
                        select: {
                            id: true,
                            title: true,
                            coverUrl: true,
                            artist: { select: { id: true, name: true } },
                        },
                    },
                },
            });
            result.push(
                ...rows
                    .filter(
                        (row) =>
                            row.origin === "FEDERATED" ||
                            (row.origin === "LOCAL" &&
                                Boolean(row.filePath?.trim())),
                    )
                    .map((row) => ({
                        id: row.id,
                        title: row.title,
                        duration: row.duration,
                        trackNo: row.trackNo,
                        artist: row.album.artist,
                        album: {
                            id: row.album.id,
                            title: row.album.title,
                            coverArt: row.album.coverUrl,
                        },
                    })),
            );
        }
        return result;
    };

function excludedIdentityCandidates(
    exclude: readonly string[],
): RecommendationCandidate[] {
    const result = new Map<string, RecommendationCandidate>();
    for (const value of exclude) {
        const video = value.startsWith("yt:") ? value.slice(3) : value;
        if (/^[A-Za-z0-9_-]{11}$/.test(video)) {
            const candidate = providerTrackIdentityToCandidate({
                source: "youtube",
                providerTrackId: video,
                title: "",
                artist: "",
            });
            result.set(`youtube:${video}`, candidate);
        }
        const local = value.startsWith("library:") ? value.slice(8) : value;
        if (/^[A-Za-z0-9_-]{1,128}$/.test(local)) {
            const candidate = providerTrackIdentityToCandidate({
                source: "library",
                providerTrackId: local,
                title: "",
                artist: "",
            });
            result.set(`library:${local}`, candidate);
        }
    }
    return [...result.values()];
}

const admitCandidates: RadioContinuationLoaderDependencies["admitCandidates"] =
    async (userId, candidates, policyTime, exclude) => {
        if (candidates.length === 0) return { candidates, degradedSources: [] };
        const degraded = new Set<string>();
        const videos = candidates.flatMap((c) =>
            c.provider.youtubeVideoId ? [c.provider.youtubeVideoId] : [],
        );
        const localIds = candidates
            .filter((c) => c.source === "library")
            .map((c) => c.id);
        const excluded = excludedIdentityCandidates(exclude);
        const [youtubeDislikes, localDislikes, canonicalDislikes, mappings] =
            await Promise.all([
                readOr(
                    "radio-youtube-dislikes",
                    degraded,
                    new Set<string>(),
                    () => loadDislikedYouTubeIds(userId, videos),
                ),
                readOr(
                    "radio-library-dislikes",
                    degraded,
                    [] as { entityId: string }[],
                    () =>
                        localIds.length
                            ? prisma.dislikedEntity.findMany({
                                  where: {
                                      userId,
                                      entityType: "track",
                                      entityId: { in: localIds },
                                  },
                                  select: { entityId: true },
                              })
                            : Promise.resolve([]),
                ),
                readOr<ReadonlySet<string>>(
                    "radio-canonical-dislikes",
                    degraded,
                    new Set(),
                    () =>
                        recommendationFeatureStore.loadDislikedCanonicalKeys(
                            userId,
                        ),
                ),
                readOr(
                    "radio-canonical-mappings",
                    degraded,
                    [] as Awaited<
                        ReturnType<typeof findMappedCanonicalCandidates>
                    >,
                    () =>
                        findMappedCanonicalCandidates([
                            ...candidates,
                            ...excluded,
                        ]),
                ),
            ]);
        const mapped = candidates.map((candidate, index) =>
            mappings[index]
                ? {
                      ...candidate,
                      canonicalRecordingId: mappings[index]!.id,
                      canonicalKey: mappings[index]!.canonicalKey,
                  }
                : candidate,
        );
        const queuedKeys = new Set(
            mappings
                .slice(candidates.length)
                .flatMap((mapping) => (mapping ? [mapping.canonicalKey] : [])),
        );
        const viewed = await readOr(
            "radio-viewed-history",
            degraded,
            new Set<string>(),
            () =>
                loadRecentlyViewedCanonicalKeys(
                    userId,
                    mapped.map((c) => c.canonicalKey),
                    policyTime,
                ),
        );
        const dislikedLocalIds = new Set(
            localDislikes.map((row) => row.entityId),
        );
        return {
            candidates: mapped.filter(
                (candidate) =>
                    !(
                        candidate.provider.youtubeVideoId &&
                        youtubeDislikes.has(candidate.provider.youtubeVideoId)
                    ) &&
                    !(
                        candidate.source === "library" &&
                        dislikedLocalIds.has(candidate.id)
                    ) &&
                    !canonicalDislikes.has(candidate.canonicalKey) &&
                    !viewed.has(candidate.canonicalKey) &&
                    !queuedKeys.has(candidate.canonicalKey),
            ),
            degradedSources: [...degraded],
        };
    };

/** Runtime seed adapter: no unrelated feed, new provider cursor or post-generation row dropping. */
export const loadRadioContinuationCandidates = createRadioContinuationLoader({
    loadLibraryTracks,
    admitCandidates,
    loadPreferences: async (userId, policyTime) => {
        const degraded = new Set<string>();
        const emptyRepeat = () => ({
            videoIds: new Set<string>(),
            songKeys: new Set<string>(),
            hardVideoIds: new Set<string>(),
            hardSongKeys: new Set<string>(),
        });
        const [youtube, library, artists] = await Promise.all([
            readOr("radio-youtube-history", degraded, emptyRepeat(), () =>
                loadYouTubeRepeatExclusions(userId, policyTime),
            ),
            readOr("radio-library-history", degraded, emptyRepeat(), () =>
                loadLibraryRepeatExclusions(userId, policyTime),
            ),
            readOr(
                "radio-artist-preferences",
                degraded,
                new Set<string>(),
                () => loadSuppressedYouTubeArtists(userId, policyTime),
            ),
        ]);
        return {
            ids: new Set([...youtube.videoIds, ...library.videoIds]),
            songKeys: new Set([...youtube.songKeys, ...library.songKeys]),
            suppressedArtists: artists,
            degradedSources: [...degraded],
        };
    },
    loadSeedTracks: async (input, admitTrackIds) => {
        const origin = input.radioOrigin;
        const refreshRemotePool = input.cursor > 0;
        const degraded = new Set<string>();
        let source: "youtube-radio" | "artist-radio" | "library-radio" =
            "library-radio";
        try {
            if (origin.kind === "track" && origin.source === "youtube") {
                source = "youtube-radio";
                return {
                    tracks: refreshRemotePool
                        ? await buildRemoteTrackRadio(origin.id, input.limit, {
                              refresh: true,
                          })
                        : await buildRemoteTrackRadio(origin.id, input.limit),
                    degradedSources: [],
                };
            }
            let artistId =
                origin.source === "library" && origin.kind === "artist"
                    ? origin.id
                    : null;
            if (origin.source === "discovery") {
                source = "artist-radio";
                const matched = await prisma.artist.findFirst({
                    where: {
                        name: { equals: origin.name, mode: "insensitive" },
                    },
                    select: { id: true },
                });
                if (!matched) {
                    const onPartialFailure = () => {
                        degraded.add("artist-radio");
                    };
                    const tracks = refreshRemotePool
                        ? await buildRemoteArtistRadio(
                              origin.name,
                              input.limit,
                              onPartialFailure,
                              { refresh: true },
                          )
                        : await buildRemoteArtistRadio(
                              origin.name,
                              input.limit,
                              onPartialFailure,
                          );
                    return { tracks, degradedSources: [...degraded] };
                }
                artistId = matched.id;
            }
            if (origin.kind === "artist" && origin.source === "library") {
                const artist = await prisma.artist.findUnique({
                    where: { id: origin.id },
                    select: { id: true },
                });
                if (!artist)
                    throw new LibrarySeedRadioError(404, "Artist not found");
            }
            if (artistId) source = "artist-radio";
            const selection = await selectLibrarySeedRadio({
                type: artistId ? "artist" : "vibe",
                value: artistId ?? (origin.kind === "track" ? origin.id : ""),
                limit: input.limit,
                userId: input.userId,
                admitTrackIds,
                allowRandomFallback: false,
                onRemotePartialFailure: () => degraded.add("artist-radio"),
                ...(refreshRemotePool && artistId
                    ? { refreshRemotePool: true }
                    : {}),
            });
            return {
                tracks:
                    "tracks" in selection
                        ? selection.tracks
                        : await loadLibraryTracks(selection.trackIds),
                degradedSources: [...degraded],
            };
        } catch (error) {
            if (error instanceof LibrarySeedRadioError) throw error;
            log.warn("Radio seed source unavailable", { source });
            return { tracks: [], degradedSources: [source] };
        }
    },
});
