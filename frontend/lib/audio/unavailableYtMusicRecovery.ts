import type { Track } from "../audio-state-context";

export interface UnavailableYtMusicRecoveryRequest {
    originalVideoId: string;
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
    excludedVideoIds: string[];
    playlistItemId?: string;
    expectedTrackYtMusicId?: string;
}

export type UnavailableYtMusicRecoveryResponse =
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

export type UnavailableYtMusicRecoveryOutcome =
    | "replaced"
    | "no_candidate"
    | "original_available"
    | "stale"
    | "failed"
    | "not_applicable";

interface UnavailableYtMusicRecoveryDependencies {
    request(
        input: UnavailableYtMusicRecoveryRequest,
    ): Promise<UnavailableYtMusicRecoveryResponse>;
    getCurrentTrack(): Track | null;
    applyReplacement(
        expectedTrack: Track,
        replacement: Extract<
            UnavailableYtMusicRecoveryResponse,
            { status: "replaced" }
        >["replacement"],
    ): void;
    isActive?(): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isRecoveryResponse(
    value: unknown,
): value is UnavailableYtMusicRecoveryResponse {
    if (
        !isRecord(value) ||
        typeof value.originalVideoId !== "string" ||
        typeof value.persisted !== "boolean"
    ) {
        return false;
    }
    if (
        value.status === "original_available" ||
        value.status === "no_candidate"
    ) {
        return value.replacement === null && value.persisted === false;
    }
    if (value.status !== "replaced" || !isRecord(value.replacement)) {
        return false;
    }
    return (
        typeof value.replacement.videoId === "string" &&
        typeof value.replacement.title === "string" &&
        typeof value.replacement.duration === "number" &&
        Number.isFinite(value.replacement.duration) &&
        value.replacement.duration >= 0 &&
        (value.replacement.trackYtMusicId === undefined ||
            (typeof value.replacement.trackYtMusicId === "string" &&
                value.replacement.trackYtMusicId.length > 0))
    );
}

function isSameProviderIdentity(
    track: Track | null,
    expectedTrack: Track,
): boolean {
    return Boolean(
        track &&
        (expectedTrack.playlistItemId
            ? track.playlistItemId === expectedTrack.playlistItemId
            : track.id === expectedTrack.id) &&
        track.streamSource === "youtube" &&
        track.youtubeVideoId === expectedTrack.youtubeVideoId,
    );
}

function toRequest(track: Track): UnavailableYtMusicRecoveryRequest | null {
    const originalVideoId = track.youtubeVideoId?.trim();
    const artist = track.artist?.name?.trim();
    const title = track.title?.trim();
    if (
        track.streamSource !== "youtube" ||
        !originalVideoId ||
        !artist ||
        !title
    ) {
        return null;
    }
    const albumTitle = track.album?.title?.trim();

    return {
        originalVideoId,
        artist,
        title,
        ...(albumTitle ? { albumTitle } : {}),
        ...(Number.isFinite(track.duration) && track.duration > 0
            ? { duration: track.duration }
            : {}),
        excludedVideoIds: [originalVideoId],
        ...(track.playlistItemId && track.trackYtMusicId
            ? {
                  playlistItemId: track.playlistItemId,
                  expectedTrackYtMusicId: track.trackYtMusicId,
              }
            : {}),
    };
}

/**
 * Correlates provider replacement responses with the still-failing track and
 * singleflights duplicate engine errors for the same logical queue entry.
 */
export function createUnavailableYtMusicRecoveryCoordinator(
    dependencies: UnavailableYtMusicRecoveryDependencies,
) {
    const inFlight = new Map<
        string,
        Promise<UnavailableYtMusicRecoveryOutcome>
    >();

    const run = async (
        track: Track,
        request: UnavailableYtMusicRecoveryRequest,
    ): Promise<UnavailableYtMusicRecoveryOutcome> => {
        let rawResponse: unknown;
        try {
            rawResponse = await dependencies.request(request);
        } catch {
            return "failed";
        }
        if (!isRecoveryResponse(rawResponse)) return "failed";
        const response = rawResponse;

        try {
            if (response.originalVideoId !== request.originalVideoId) {
                return "failed";
            }
            if (dependencies.isActive?.() === false) return "stale";
            if (
                !isSameProviderIdentity(dependencies.getCurrentTrack(), track)
            ) {
                return "stale";
            }
            if (response.status !== "replaced") return response.status;

            const replacementVideoId = response.replacement.videoId.trim();
            if (
                !/^[A-Za-z0-9_-]{11}$/.test(replacementVideoId) ||
                replacementVideoId === request.originalVideoId
            ) {
                return "failed";
            }

            dependencies.applyReplacement(track, {
                videoId: replacementVideoId,
                title: response.replacement.title,
                duration: response.replacement.duration,
                ...(response.persisted && response.replacement.trackYtMusicId
                    ? { trackYtMusicId: response.replacement.trackYtMusicId }
                    : {}),
            });
            return "replaced";
        } catch {
            return "failed";
        }
    };

    return {
        recover(track: Track): Promise<UnavailableYtMusicRecoveryOutcome> {
            const request = toRequest(track);
            if (!request) return Promise.resolve("not_applicable");
            const occurrenceKey = track.playlistItemId ?? track.id;
            const key = `${occurrenceKey}\u0000${request.originalVideoId}`;
            const existing = inFlight.get(key);
            if (existing) return existing;

            const flight = run(track, request).finally(() => {
                if (inFlight.get(key) === flight) inFlight.delete(key);
            });
            inFlight.set(key, flight);
            return flight;
        },
    };
}
