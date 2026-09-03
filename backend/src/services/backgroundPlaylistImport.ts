import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { buildGenericImportPlaylistMixId } from "./genericImportIdentity";
import { canonicalIdentityResolver } from "./recommendations/canonicalIdentity";
import { persistImportedProviderIdentity } from "./recommendations/durableIdentityPersistence";
import type {
    PlaylistImportSummary,
    ResolvedTrack,
} from "./playlistImportService";
import { trackMappingService } from "./trackMappingService";

const log = logger.child("BackgroundPlaylistImport");
const MAPPING_CONCURRENCY = 8;

interface InitializeBackgroundImportInput {
    jobId: string;
    userId: string;
    playlistName: string;
    tracks: ResolvedTrack[];
}

interface PersistResolutionInput {
    jobId: string;
    userId: string;
    playlistId: string;
    expectedResolutionAttempt: number;
    newlyResolved: ResolvedTrack[];
    snapshot: ResolvedTrack[];
    summary: PlaylistImportSummary;
    progress: number;
    resolutionProcessed: number;
}

function initialSummary(total: number): PlaylistImportSummary {
    return {
        total,
        local: 0,
        youtube: 0,
        tidal: 0,
        unresolved: total,
    };
}

function validateSourcePositions(tracks: ResolvedTrack[]): void {
    for (const [position, track] of tracks.entries()) {
        if (track.index !== position) {
            throw new Error(
                "Import source positions must be contiguous ordered integers",
            );
        }
    }
}

function validateResolvedProviderIdentity(track: ResolvedTrack): void {
    if (track.source === "unresolved") return;
    const identities = {
        local: track.trackId,
        tidal: track.trackTidalId,
        youtube: track.trackYtMusicId,
    } as const;
    if (
        track.source !== "local" &&
        track.source !== "tidal" &&
        track.source !== "youtube"
    ) {
        throw new Error(
            "Resolved import track has an invalid provider identity",
        );
    }
    const expectedIdentity = identities[track.source];
    const presentIdentityCount = Object.values(identities).filter(
        (identity) => typeof identity === "string" && identity.trim() !== "",
    ).length;
    if (
        typeof expectedIdentity !== "string" ||
        expectedIdentity.trim() !== expectedIdentity ||
        expectedIdentity === "" ||
        presentIdentityCount !== 1
    ) {
        throw new Error(
            "Resolved import track has an invalid provider identity",
        );
    }
}

async function mapWithConcurrency<T>(
    values: T[],
    concurrency: number,
    worker: (value: T) => Promise<void>,
): Promise<void> {
    let cursor = 0;
    const limit = Math.max(1, Math.min(concurrency, values.length));
    const workers = Array.from({ length: limit }, async () => {
        while (cursor < values.length) {
            const value = values[cursor];
            cursor += 1;
            await worker(value);
        }
    });
    await Promise.all(workers);
}

/**
 * Owns atomic persistence for a playlist that becomes visible before provider
 * resolution finishes.
 */
class BackgroundPlaylistImport {
    /** Creates the visible playlist shell and durable source snapshot once. */
    async initialize(
        input: InitializeBackgroundImportInput,
    ): Promise<{ playlistId: string; resolutionAttempt: number }> {
        validateSourcePositions(input.tracks);
        const mixId = buildGenericImportPlaylistMixId(input.jobId);
        const startedAt = new Date();

        return prisma.$transaction(async (transaction) => {
            let playlist = await transaction.playlist.findUnique({
                where: {
                    userId_mixId: {
                        userId: input.userId,
                        mixId,
                    },
                },
                select: { id: true },
            });

            if (!playlist) {
                playlist = await transaction.playlist.create({
                    data: {
                        userId: input.userId,
                        name: input.playlistName,
                        mixId,
                    },
                    select: { id: true },
                });
                if (input.tracks.length > 0) {
                    const pending =
                        await transaction.playlistPendingTrack.createMany({
                            data: input.tracks.map((track) => ({
                                playlistId: playlist!.id,
                                spotifyArtist: track.artist,
                                spotifyTitle: track.title,
                                spotifyAlbum: track.album || "",
                                sort: track.index,
                            })),
                        });
                    if (pending.count !== input.tracks.length) {
                        throw new Error(
                            "Playlist import placeholder persistence was incomplete",
                        );
                    }
                }
            }

            const transition = await transaction.importJob.updateMany({
                where: {
                    id: input.jobId,
                    userId: input.userId,
                    status: "resolving",
                },
                data: {
                    playlistName: input.playlistName,
                    progress: 25,
                    summary: initialSummary(
                        input.tracks.length,
                    ) as unknown as Prisma.InputJsonValue,
                    resolvedTracks:
                        input.tracks as unknown as Prisma.InputJsonValue,
                    createdPlaylistId: playlist.id,
                    resolutionStartedAt: startedAt,
                    resolutionProcessed: 0,
                    resolutionAttempt: { increment: 1 },
                    error: null,
                },
            });
            if (transition.count === 0) {
                throw new Error(
                    "Import job stopped before playlist initialization",
                );
            }

            const transitionedJob = await transaction.importJob.findUnique({
                where: { id: input.jobId },
                select: { resolutionAttempt: true },
            });
            if (!transitionedJob) {
                throw new Error(
                    "Import job disappeared during playlist initialization",
                );
            }

            return {
                playlistId: playlist.id,
                resolutionAttempt: transitionedJob.resolutionAttempt,
            };
        });
    }

    /** Publishes one resolved batch and advances its durable job snapshot. */
    async persistResolution(input: PersistResolutionInput): Promise<boolean> {
        const resolvedTracks = input.newlyResolved.filter(
            (track) => track.source !== "unresolved",
        );
        resolvedTracks.forEach(validateResolvedProviderIdentity);
        const persisted = await prisma.$transaction(async (transaction) => {
            const ownedPlaylist = await transaction.playlist.findFirst({
                where: {
                    id: input.playlistId,
                    userId: input.userId,
                },
                select: { id: true },
            });
            if (!ownedPlaylist) {
                throw new Error("Import playlist is missing or not owned");
            }

            const transition = await transaction.importJob.updateMany({
                where: {
                    id: input.jobId,
                    userId: input.userId,
                    status: "resolving",
                    createdPlaylistId: input.playlistId,
                    resolutionAttempt: input.expectedResolutionAttempt,
                },
                data: {
                    progress: input.progress,
                    summary: input.summary as unknown as Prisma.InputJsonValue,
                    resolvedTracks:
                        input.snapshot as unknown as Prisma.InputJsonValue,
                    resolutionProcessed: input.resolutionProcessed,
                },
            });
            if (transition.count === 0) return false;

            if (resolvedTracks.length > 0) {
                const pendingPositions =
                    await transaction.playlistPendingTrack.findMany({
                        where: {
                            playlistId: input.playlistId,
                            sort: {
                                in: resolvedTracks.map((track) => track.index),
                            },
                        },
                        select: { sort: true },
                    });
                const pendingPositionSet = new Set(
                    pendingPositions.map(({ sort }) => sort),
                );
                const publishableTracks = resolvedTracks.filter((track) =>
                    pendingPositionSet.has(track.index),
                );
                if (publishableTracks.length === 0) return true;
                await transaction.playlistItem.createMany({
                    data: publishableTracks.map((track) => ({
                        playlistId: input.playlistId,
                        trackId: track.trackId || null,
                        trackTidalId: track.trackTidalId || null,
                        trackYtMusicId: track.trackYtMusicId || null,
                        sort: track.index,
                    })),
                    skipDuplicates: true,
                });
                await transaction.playlistPendingTrack.deleteMany({
                    where: {
                        playlistId: input.playlistId,
                        sort: {
                            in: publishableTracks.map((track) => track.index),
                        },
                    },
                });
            }
            return true;
        });

        if (!persisted) return false;
        await mapWithConcurrency(
            resolvedTracks,
            MAPPING_CONCURRENCY,
            async (track) => {
                try {
                    await trackMappingService.createMapping({
                        trackId: track.trackId,
                        trackTidalId: track.trackTidalId,
                        trackYtMusicId: track.trackYtMusicId,
                        confidence: track.confidence / 100,
                        source: "import-match",
                    });
                    const providerIdentity =
                        track.source === "youtube" && track.videoId
                            ? {
                                  source: "youtube" as const,
                                  providerTrackId: track.videoId,
                              }
                            : track.source === "tidal" && track.tidalId
                              ? {
                                    source: "tidal" as const,
                                    providerTrackId: track.tidalId,
                                }
                              : track.source === "local" && track.trackId
                                ? {
                                      source: "library" as const,
                                      providerTrackId: track.trackId,
                                  }
                                : null;
                    if (track.isrc && providerIdentity) {
                        const providerTrack = {
                            ...providerIdentity,
                            title: track.title,
                            artist: track.artist,
                            album: track.album,
                            duration: track.duration,
                            isrc: track.isrc,
                        };
                        const canonical =
                            await canonicalIdentityResolver.resolveProviderTrack(
                                providerTrack,
                            );
                        await persistImportedProviderIdentity(
                            providerTrack,
                            canonical,
                        );
                    }
                } catch (error) {
                    log.warn(
                        "Track mapping creation failed after import batch",
                        {
                            error,
                        },
                    );
                }
            },
        );
        return true;
    }
}

/** Atomic persistence module for progressively resolved playlist imports. */
export const backgroundPlaylistImport = new BackgroundPlaylistImport();
