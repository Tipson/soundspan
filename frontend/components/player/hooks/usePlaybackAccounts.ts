import { useCallback, useEffect, type MutableRefObject } from "react";
import { api } from "@/lib/api";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import { AUTO_MATCH_VIBE_RETRY_COOLDOWN_MS } from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type {
    VibeModeStartOptions,
    VibeModeStartResult,
    VibeQueueMutationKind,
} from "@/lib/audio-controls-types";
import type { AutoMatchVibeRequestResult } from "../autoMatchVibePlayback";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

/** Keeps the YouTube Music authentication snapshot current. */
export function useYtMusicAuth(
    ytMusicAuthenticatedRef: MutableRefObject<boolean>,
): void {
    // Fetch YouTube Music auth status on mount and whenever the user
    // connects/disconnects their YT Music account via settings.
    useEffect(() => {
        const refreshYtAuth = () => {
            api.getYtMusicStatus()
                .then((status) => {
                    ytMusicAuthenticatedRef.current =
                        !!status.enabled &&
                        !!status.available &&
                        !!status.authenticated;
                })
                .catch(() => {
                    ytMusicAuthenticatedRef.current = false;
                });
        };
        refreshYtAuth();
        if (typeof window !== "undefined") {
            window.addEventListener("ytmusic-auth-changed", refreshYtAuth);
            return () => {
                window.removeEventListener(
                    "ytmusic-auth-changed",
                    refreshYtAuth,
                );
            };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);
}

interface UseAutoMatchVibeOptions {
    refs: PlaybackOrchestratorRefs;
    startVibeMode: (
        options?: VibeModeStartOptions,
    ) => Promise<VibeModeStartResult>;
}

const NO_AUTO_MATCH_VIBE_RESULT: AutoMatchVibeRequestResult = {
    didExtendQueue: false,
    queueMutation: null,
};

/** Returns the existing deduplicated automatic Vibe request callback. */
export function useAutoMatchVibe({
    refs,
    startVibeMode,
}: UseAutoMatchVibeOptions) {
    const {
        autoMatchVibePromiseRef,
        autoMatchVibeTrackIdRef,
        autoMatchVibeLastAttemptAtRef,
    } = refs;

    const requestAutoMatchVibe = useCallback(
        (
            seedTrackId: string | null,
            options?: { force?: boolean },
        ): Promise<AutoMatchVibeRequestResult> => {
            if (!seedTrackId) {
                return Promise.resolve(NO_AUTO_MATCH_VIBE_RESULT);
            }
            if (getListenTogetherSessionSnapshot()?.groupId) {
                return Promise.resolve(NO_AUTO_MATCH_VIBE_RESULT);
            }

            if (autoMatchVibePromiseRef.current) {
                if (autoMatchVibeTrackIdRef.current === seedTrackId) {
                    return autoMatchVibePromiseRef.current;
                }
                return Promise.resolve(NO_AUTO_MATCH_VIBE_RESULT);
            }

            const now = Date.now();
            if (
                !options?.force &&
                autoMatchVibeTrackIdRef.current === seedTrackId &&
                now - autoMatchVibeLastAttemptAtRef.current <
                    AUTO_MATCH_VIBE_RETRY_COOLDOWN_MS
            ) {
                return Promise.resolve(NO_AUTO_MATCH_VIBE_RESULT);
            }

            autoMatchVibeTrackIdRef.current = seedTrackId;
            autoMatchVibeLastAttemptAtRef.current = now;

            const queueCommitToken = {};
            let committedQueueMutation: VibeQueueMutationKind | null = null;
            const request = startVibeMode({
                queueCommitToken,
                onLocalQueueCommit: (commit) => {
                    if (commit.token === queueCommitToken) {
                        committedQueueMutation = commit.mutation;
                    }
                },
            })
                .then((result): AutoMatchVibeRequestResult => {
                    if (
                        !result.success ||
                        result.trackCount <= 0 ||
                        committedQueueMutation === null
                    ) {
                        return NO_AUTO_MATCH_VIBE_RESULT;
                    }
                    return {
                        didExtendQueue: true,
                        queueMutation: committedQueueMutation,
                    };
                })
                .catch((error) => {
                    sharedFrontendLogger.error(
                        "[AudioPlaybackOrchestrator] Auto Match Vibe request failed:",
                        error,
                    );
                    return NO_AUTO_MATCH_VIBE_RESULT;
                })
                .finally(() => {
                    autoMatchVibePromiseRef.current = null;
                });

            autoMatchVibePromiseRef.current = request;
            return request;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [startVibeMode],
    );

    return requestAutoMatchVibe;
}
