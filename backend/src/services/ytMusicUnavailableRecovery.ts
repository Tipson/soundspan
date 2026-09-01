import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { coalesceInFlightByKey } from "../utils/singleflight";
import { trackMappingService } from "./trackMappingService";
import {
    ytMusicService,
    type YtMusicPlayableAlternate,
    type YtMusicPlayableAlternateInput,
} from "./youtubeMusic";

export interface YtMusicUnavailableRecoveryInput {
    originalVideoId: string;
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
    excludedVideoIds?: string[];
    playlistItemId?: string;
    expectedTrackYtMusicId?: string;
}

export interface PersistPlaylistYtMusicReplacementInput {
    userId: string;
    playlistItemId: string;
    expectedTrackYtMusicId: string;
    replacementTrackYtMusicId: string;
}

export type YtMusicUnavailableRecoveryResult =
    | {
          status: "original_available" | "no_candidate";
          originalVideoId: string;
          replacement: null;
          persisted: false;
      }
    | {
          status: "replaced";
          originalVideoId: string;
          replacement: {
              videoId: string;
              title: string;
              duration: number;
              trackYtMusicId?: string;
          };
          persisted: boolean;
      };

export interface YtMusicUnavailableRecoveryDependencies {
    getStreamInfo(videoId: string): Promise<unknown>;
    findPlayableAlternate(
        userId: string,
        input: YtMusicPlayableAlternateInput,
    ): Promise<YtMusicPlayableAlternate | null>;
    ensureRemoteTrack(
        alternate: YtMusicPlayableAlternate,
    ): Promise<{ id: string }>;
    persistPlaylistReplacement(
        input: PersistPlaylistYtMusicReplacementInput,
    ): Promise<boolean>;
}

interface RecoveryServiceOptions {
    maxConcurrency?: number;
}

interface PlaylistReplacementTransactionClient {
    playlistItem: {
        findFirst(
            args: unknown,
        ): Promise<{ playlistId: string } | { id: string } | null>;
        updateMany(args: unknown): Promise<{ count: number }>;
    };
}

interface PlaylistReplacementDb {
    $transaction<T>(
        callback: (tx: PlaylistReplacementTransactionClient) => Promise<T>,
    ): Promise<T>;
}

class AsyncConcurrencyGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    private acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    private release(): void {
        const next = this.waiters.shift();
        if (next) {
            // Hand the occupied slot directly to the queued caller. Keeping
            // active unchanged prevents a newly arriving caller from stealing it.
            next();
            return;
        }
        this.active -= 1;
    }

    async run<T>(factory: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await factory();
        } finally {
            this.release();
        }
    }
}

function getHttpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== "object") return undefined;
    const status = (response as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
}

function isConfirmedUnavailable(error: unknown): boolean {
    const status = getHttpStatus(error);
    return status === 404 || status === 451;
}

function buildRecoveryKey(
    userId: string,
    input: YtMusicUnavailableRecoveryInput,
): string {
    return [
        userId,
        input.originalVideoId,
        input.playlistItemId ?? "",
        input.expectedTrackYtMusicId ?? "",
        input.artist,
        input.title,
        input.albumTitle ?? "",
        String(input.duration ?? ""),
        [...(input.excludedVideoIds ?? [])].sort().join(","),
    ].join("\u0000");
}

/**
 * Compare-and-swap one owned playlist relation. The existing provider row is
 * never mutated, because likes, plays, mappings, and other playlists may share it.
 */
export async function persistPlaylistYtMusicReplacement(
    db: PlaylistReplacementDb,
    input: PersistPlaylistYtMusicReplacementInput,
): Promise<boolean> {
    return db.$transaction(async (tx) => {
        const target = await tx.playlistItem.findFirst({
            where: {
                id: input.playlistItemId,
                trackYtMusicId: input.expectedTrackYtMusicId,
                trackId: null,
                trackTidalId: null,
                playlist: { userId: input.userId },
            },
            select: { playlistId: true },
        });
        if (!target || !("playlistId" in target)) return false;

        const updated = await tx.playlistItem.updateMany({
            where: {
                id: input.playlistItemId,
                playlistId: target.playlistId,
                trackYtMusicId: input.expectedTrackYtMusicId,
                trackId: null,
                trackTidalId: null,
            },
            data: { trackYtMusicId: input.replacementTrackYtMusicId },
        });
        return updated.count === 1;
    });
}

export function createYtMusicUnavailableRecoveryService(
    dependencies: YtMusicUnavailableRecoveryDependencies,
    options: RecoveryServiceOptions = {},
) {
    const inFlight = new Map<
        string,
        Promise<YtMusicUnavailableRecoveryResult>
    >();
    const requestedConcurrency = options.maxConcurrency ?? 2;
    const gate = new AsyncConcurrencyGate(
        Number.isFinite(requestedConcurrency)
            ? Math.max(1, Math.trunc(requestedConcurrency))
            : 2,
    );

    const recoverOnce = async (
        userId: string,
        input: YtMusicUnavailableRecoveryInput,
    ): Promise<YtMusicUnavailableRecoveryResult> => {
        try {
            await dependencies.getStreamInfo(input.originalVideoId);
            return {
                status: "original_available",
                originalVideoId: input.originalVideoId,
                replacement: null,
                persisted: false,
            };
        } catch (error) {
            if (!isConfirmedUnavailable(error)) throw error;
        }

        const excludedVideoIds = Array.from(
            new Set([input.originalVideoId, ...(input.excludedVideoIds ?? [])]),
        );
        const alternate = await dependencies.findPlayableAlternate(
            "__public__",
            {
                artist: input.artist,
                title: input.title,
                ...(input.albumTitle ? { albumTitle: input.albumTitle } : {}),
                ...(input.duration ? { duration: input.duration } : {}),
                excludedVideoIds,
            },
        );
        if (!alternate) {
            return {
                status: "no_candidate",
                originalVideoId: input.originalVideoId,
                replacement: null,
                persisted: false,
            };
        }

        let trackYtMusicId: string | undefined;
        let persisted = false;
        try {
            const ensured = await dependencies.ensureRemoteTrack(alternate);
            trackYtMusicId = ensured.id;
            if (
                input.playlistItemId &&
                input.expectedTrackYtMusicId &&
                trackYtMusicId
            ) {
                persisted = await dependencies.persistPlaylistReplacement({
                    userId,
                    playlistItemId: input.playlistItemId,
                    expectedTrackYtMusicId: input.expectedTrackYtMusicId,
                    replacementTrackYtMusicId: trackYtMusicId,
                });
            }
        } catch (error) {
            logger.warn(
                "[YTMusic Recovery] Validated replacement could not be persisted; continuing with runtime replacement",
                error,
            );
        }

        return {
            status: "replaced",
            originalVideoId: input.originalVideoId,
            replacement: {
                videoId: alternate.videoId,
                title: alternate.title,
                duration: alternate.duration,
                ...(trackYtMusicId ? { trackYtMusicId } : {}),
            },
            persisted,
        };
    };

    return {
        recover(
            userId: string,
            input: YtMusicUnavailableRecoveryInput,
        ): Promise<YtMusicUnavailableRecoveryResult> {
            const key = buildRecoveryKey(userId, input);
            return coalesceInFlightByKey(inFlight, key, () =>
                gate.run(() => recoverOnce(userId, input)),
            );
        },
    };
}

export const ytMusicUnavailableRecoveryService =
    createYtMusicUnavailableRecoveryService({
        getStreamInfo: (videoId) =>
            ytMusicService.getStreamInfo("__public__", videoId, undefined, {
                timeoutMs: 15_000,
                maxRetries: 0,
            }),
        findPlayableAlternate: (userId, input) =>
            ytMusicService.findPlayableAlternateForTrack(userId, input),
        ensureRemoteTrack: async (alternate) => {
            const result = await trackMappingService.ensureRemoteTrack({
                provider: "youtube",
                videoId: alternate.videoId,
                title: alternate.title,
                artist: alternate.artist,
                album: alternate.album || "Single",
                duration: Math.max(0, Math.round(alternate.duration)),
                ...(alternate.thumbnailUrl
                    ? { thumbnailUrl: alternate.thumbnailUrl }
                    : {}),
            });
            return { id: result.id };
        },
        persistPlaylistReplacement: (input) =>
            persistPlaylistYtMusicReplacement(
                prisma as unknown as PlaylistReplacementDb,
                input,
            ),
    });
