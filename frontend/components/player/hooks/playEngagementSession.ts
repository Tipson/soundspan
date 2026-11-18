import type {
    PlayEngagementInput,
    PlayEngagementResponse,
    PlayLogInput,
    PlayLogResponse,
    PlayRecommendationContext,
    PlayWaveMode,
} from "@/lib/api/plays";
import { readPlayEngagementAck } from "@/lib/playCreateWire";
import { readSmartShuffleLineage } from "@/lib/audio/finiteSmartShuffle";
import type {
    AdaptiveWaveSkipCapture,
    AdaptiveWaveSkipReceipt,
} from "@/lib/audio/adaptiveWaveFeedback";

const MAX_LISTENED_SECONDS = 86_400;
const MAX_CONTIGUOUS_PROGRESS_DELTA_SECONDS = 10;
const EARLY_SKIP_SECONDS = 30;
const EARLY_SKIP_RATIO = 0.2;
const DURABLE_CHECKPOINT_SECONDS = 30;

/** A selected durable run owns all retries; the tracker must never fall back after selection. */
export interface PlayEngagementDelivery {
    created: Promise<PlayLogResponse>;
    noteEngagement(
        input: PlayEngagementInput,
        final: boolean,
    ): Promise<boolean>;
    /** This optional signal comes only after the durable coordinator receives a real PATCH ACK. */
    observeEngagementCommits?(
        listener: (input: PlayEngagementInput) => void,
    ): () => void;
}

interface PlayEngagementDependencies {
    /** Null means legacy was selected before a durable run was created. */
    beginPlay?(input: PlayLogInput): PlayEngagementDelivery | null;
    captureSkippedFeedback?(): AdaptiveWaveSkipCapture | null;
    logPlay(input: PlayLogInput): Promise<PlayLogResponse>;
    updatePlayEngagement(
        playId: string,
        input: PlayEngagementInput,
    ): Promise<PlayEngagementResponse>;
    onError?(stage: "create" | "finalize", error: unknown): void;
}

interface StartPlayEngagementInput {
    key: string;
    play: PlayLogInput;
    durationSeconds: number;
}

type FinishReason = "completed" | "failed" | "transition";

interface ActivePlayEngagement {
    key: string;
    durationSeconds: number;
    listenedSeconds: number;
    lastPositionSeconds: number;
    maxPositionSeconds: number;
    finalInput: PlayEngagementInput | null;
    playId: string | null;
    finalSent: boolean;
    delivery: PlayEngagementDelivery | null;
    checkpointSeconds: number;
    skipCapture: AdaptiveWaveSkipCapture | null;
    skipReceipt: AdaptiveWaveSkipReceipt | null;
    unsubscribeCommit: (() => void) | null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function finiteNonNegative(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function completionRatio(session: ActivePlayEngagement): number {
    if (session.durationSeconds <= 0) return 0;
    return clamp(session.maxPositionSeconds / session.durationSeconds, 0, 1);
}

function finalEngagement(
    session: ActivePlayEngagement,
    reason: FinishReason,
): PlayEngagementInput {
    const ratio = reason === "completed" ? 1 : completionRatio(session);
    let outcome: PlayEngagementInput["outcome"];
    if (reason === "completed") {
        outcome = "completed";
    } else if (reason === "failed") {
        outcome = "failed";
    } else {
        outcome =
            session.listenedSeconds < EARLY_SKIP_SECONDS ||
            ratio <= EARLY_SKIP_RATIO
                ? "skipped"
                : "meaningful";
    }

    return {
        listenedSeconds: clamp(
            session.listenedSeconds,
            0,
            MAX_LISTENED_SECONDS,
        ),
        completionRatio: ratio,
        outcome,
    };
}

/** Resolve the server's bounded recommendation context from player state. */
export function resolvePlaybackRecommendationContext(
    pathname: string | null | undefined,
    vibeMode: boolean,
    waveMode: PlayWaveMode,
    smartShuffle?: unknown,
): PlayRecommendationContext {
    if (readSmartShuffleLineage(smartShuffle))
        return { playContext: "playlist" };
    const normalizedPath = pathname?.split(/[?#]/, 1)[0] ?? "";
    if (vibeMode || normalizedPath === "/vibe") {
        return { playContext: "wave", waveMode };
    }
    if (normalizedPath === "/") return { playContext: "home" };
    if (normalizedPath.startsWith("/search")) {
        return { playContext: "search" };
    }
    if (normalizedPath.startsWith("/playlist/")) {
        return { playContext: "playlist" };
    }
    if (normalizedPath.startsWith("/album/")) {
        return { playContext: "album" };
    }
    if (normalizedPath.startsWith("/artist/")) {
        return { playContext: "artist" };
    }
    if (normalizedPath.startsWith("/library")) {
        return { playContext: "library" };
    }
    return {};
}

/** Keep direct generation lineage, otherwise join the current browser-tab session. */
export function resolvePlaybackRecommendationSessionId(
    trackSessionId: string | null | undefined,
    tabSessionId: string,
): string {
    return trackSessionId?.trim() || tabSessionId;
}

/**
 * Tracks one remote play at a time and emits exactly one final engagement.
 * Durable finalization is captured before the response; legacy delivery waits for its id.
 */
export function createPlayEngagementTracker(
    dependencies: PlayEngagementDependencies,
) {
    let active: ActivePlayEngagement | null = null;
    const committed = (
        session: ActivePlayEngagement,
        input: PlayEngagementInput,
    ): void => {
        const final = session.finalInput;
        if (
            !final ||
            input.outcome !== final.outcome ||
            input.listenedSeconds < final.listenedSeconds ||
            input.completionRatio < final.completionRatio
        )
            return;
        session.skipReceipt?.commit();
        session.skipReceipt = null;
        session.unsubscribeCommit?.();
        session.unsubscribeCommit = null;
    };

    const checkpoint = (
        session: ActivePlayEngagement,
        input: PlayEngagementInput,
        final: boolean,
    ): void => {
        if (!session.delivery) return;
        // Capture synchronously, including final-before-create-ACK; the journal owns persistence ordering.
        try {
            void session.delivery.noteEngagement(input, final).then(
                (accepted) => {
                    if (!accepted)
                        dependencies.onError?.(
                            "finalize",
                            new Error("Play checkpoint was not accepted"),
                        );
                },
                (error) => dependencies.onError?.("finalize", error),
            );
        } catch (error) {
            dependencies.onError?.("finalize", error);
        }
    };

    const sendFinalIfReady = (session: ActivePlayEngagement): void => {
        if (session.finalSent || !session.finalInput) {
            return;
        }
        if (session.delivery) {
            session.finalSent = true;
            checkpoint(session, session.finalInput, true);
            return;
        }
        if (!session.playId) return;
        session.finalSent = true;
        void dependencies
            .updatePlayEngagement(session.playId, session.finalInput)
            .then((response) => {
                if (!readPlayEngagementAck(response))
                    throw new Error("Invalid Play engagement acknowledgement");
                committed(session, session.finalInput!);
            })
            .catch((error) => {
                session.skipReceipt?.abandon();
                session.skipReceipt = null;
                dependencies.onError?.("finalize", error);
            });
    };

    const finish = (reason: FinishReason): void => {
        const session = active;
        if (!session || session.finalInput) return;
        session.finalInput = finalEngagement(session, reason);
        if (session.finalInput.outcome === "skipped")
            session.skipReceipt = session.skipCapture?.() ?? null;
        if (!session.skipReceipt) {
            session.unsubscribeCommit?.();
            session.unsubscribeCommit = null;
        }
        active = null;
        sendFinalIfReady(session);
    };

    return {
        start(input: StartPlayEngagementInput): void {
            if (active?.key === input.key) return;
            if (active) finish("transition");

            let delivery: PlayEngagementDelivery | null;
            try {
                delivery = dependencies.beginPlay?.(input.play) ?? null;
            } catch (error) {
                // Selection may already have issued a key. A second keyless POST could duplicate it.
                dependencies.onError?.("create", error);
                return;
            }

            const session: ActivePlayEngagement = {
                key: input.key,
                durationSeconds: finiteNonNegative(input.durationSeconds),
                listenedSeconds: 0,
                lastPositionSeconds: 0,
                maxPositionSeconds: 0,
                finalInput: null,
                playId: null,
                finalSent: false,
                delivery,
                checkpointSeconds: 0,
                skipCapture: dependencies.captureSkippedFeedback?.() ?? null,
                skipReceipt: null,
                unsubscribeCommit: null,
            };
            session.unsubscribeCommit =
                delivery?.observeEngagementCommits?.((input) =>
                    committed(session, input),
                ) ?? null;
            active = session;
            void (delivery?.created ?? dependencies.logPlay(input.play))
                .then((response) => {
                    const playId =
                        typeof response?.id === "string"
                            ? response.id.trim()
                            : "";
                    if (!playId) {
                        throw new Error("Play response is missing id");
                    }
                    session.playId = playId;
                    sendFinalIfReady(session);
                })
                .catch((error) => {
                    session.skipReceipt?.abandon();
                    session.skipReceipt = null;
                    session.unsubscribeCommit?.();
                    session.unsubscribeCommit = null;
                    dependencies.onError?.("create", error);
                });
        },

        noteProgress(positionSeconds: number): void {
            const session = active;
            if (!session || !Number.isFinite(positionSeconds)) return;
            const position = clamp(
                finiteNonNegative(positionSeconds),
                0,
                MAX_LISTENED_SECONDS,
            );
            const delta = position - session.lastPositionSeconds;
            if (delta > 0 && delta <= MAX_CONTIGUOUS_PROGRESS_DELTA_SECONDS) {
                session.listenedSeconds += delta;
            }
            session.lastPositionSeconds = position;
            session.maxPositionSeconds = Math.max(
                session.maxPositionSeconds,
                position,
            );
            if (
                session.delivery &&
                session.listenedSeconds - session.checkpointSeconds >=
                    DURABLE_CHECKPOINT_SECONDS &&
                completionRatio(session) > EARLY_SKIP_RATIO
            ) {
                session.checkpointSeconds = session.listenedSeconds;
                checkpoint(
                    session,
                    {
                        listenedSeconds: clamp(
                            session.listenedSeconds,
                            0,
                            MAX_LISTENED_SECONDS,
                        ),
                        completionRatio: completionRatio(session),
                        outcome: "meaningful",
                    },
                    false,
                );
            }
        },

        transitionTo(nextKey: string | null): void {
            if (active && active.key !== nextKey) finish("transition");
        },

        finish,
    };
}

export type PlayEngagementTracker = ReturnType<
    typeof createPlayEngagementTracker
>;
