import { api } from "@/lib/api";
import { createRuntimeAudioEngine } from "@/lib/audio-engine";
import { resolveStreamingEngineMode } from "@/lib/audio-engine/engineMode";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    PODCAST_DEBUG_STORAGE_KEY,
    readMigratingStorageItem,
} from "@/lib/storage-migration";
import { getRecommendationSessionId } from "@/lib/recommendationSession";
import { readCachedAuthUser } from "@/lib/auth-offline-session";
import { getAuthRuntimeLease } from "@/lib/auth-runtime-generation";
import {
    createPlaybackDiagnosticQueue,
    PLAYBACK_DIAGNOSTIC_EVENTS,
    sanitizePlaybackDiagnosticFields,
} from "./playbackDiagnosticQueue";

const PLAYBACK_CLIENT_SIGNAL_EVENTS = new Set<string>([
    "player.engine_startup",
    "player.audible_start",
    "player.transition_gap",
    "player.rebuffer",
    "player.rebuffer_timeout",
    "player.rebuffer_recovered",
    "player.unexpected_stop",
    "player.unexpected_pause",
    "player.load_autoplay_decision",
    "player.autoplay_intent_conflict",
    "player.track_end_rejected",
    "player.track_end_advanced",
    "player.playback_error",
    "player.playback_cancelled",
    "player.provider_cooldown_skip",
    "player.ios_background_handoff",
]);

/** Stable runtime audio-engine facade shared by every orchestrator concern. */
export const audioEngine = createRuntimeAudioEngine();
/** Structured logger scoped to audio playback orchestration. */
export const orchestratorLogger = sharedFrontendLogger.child(
    "AudioPlaybackOrchestrator",
);

let diagnosticQueue: ReturnType<typeof createPlaybackDiagnosticQueue> | null =
    null;
let diagnosticAuthGeneration: number | null = null;
let pendingRecovery: {
    fields: Record<string, unknown>;
    position: number;
    at: number;
} | null = null;
const reportRecoveryProgress = () => {
    const pending = pendingRecovery;
    if (!pending) return;
    if (Date.now() - pending.at > 60_000) {
        pendingRecovery = null;
        return;
    }
    if (
        audioEngine.isPlaying() &&
        audioEngine.getActualCurrentTime() > pending.position + 0.05
    ) {
        pendingRecovery = null;
        logPlaybackClientMetric("player.recovery_resumed", pending.fields);
    }
};

function diagnosticOwnerId(): string | null {
    try {
        return readCachedAuthUser()?.id ?? null;
    } catch {
        return null;
    }
}

function queueDiagnostic(
    event: string | null,
    fields: Record<string, unknown>,
): boolean {
    if (!diagnosticOwnerId()) return false;
    if (!diagnosticQueue) {
        let storage: Storage | null = null;
        try {
            storage = window.sessionStorage;
        } catch {
            /* Memory-only fallback. */
        }
        diagnosticQueue = createPlaybackDiagnosticQueue({
            storage,
            ownerId: diagnosticOwnerId,
            online: () =>
                typeof navigator === "undefined" || navigator.onLine !== false,
            send: (input, signal) =>
                api.reportPlaybackClientMetric(input, signal),
        });
        const flush = () => {
            void diagnosticQueue?.flush();
        };
        window.addEventListener("online", flush);
        window.addEventListener("pageshow", flush);
        document.addEventListener("visibilitychange", flush);
    }
    const lease = getAuthRuntimeLease();
    if (diagnosticAuthGeneration !== lease.generation) {
        diagnosticAuthGeneration = lease.generation;
        lease.signal.addEventListener(
            "abort",
            () => {
                diagnosticQueue?.clear();
                pendingRecovery = null;
            },
            { once: true },
        );
    }
    if (event) diagnosticQueue.enqueue(event, fields);
    else void diagnosticQueue.flush();
    return event !== null;
}

function diagnosticContext(): Record<string, unknown> {
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    return {
        currentTimeSec: audioEngine.getActualCurrentTime(),
        durationSec: audioEngine.getDuration(),
        bufferedAheadSec: audioEngine.getBufferedAheadSec(),
        enginePlaying: audioEngine.isPlaying(),
        online: typeof navigator === "undefined" ? null : navigator.onLine,
        visibility:
            typeof document === "undefined"
                ? "unknown"
                : document.visibilityState,
        browser: /Firefox|FxiOS/.test(ua)
            ? "firefox"
            : /Edg/.test(ua)
              ? "edge"
              : /Chrome|CriOS/.test(ua)
                ? "chrome"
                : /Safari/.test(ua)
                  ? "safari"
                  : "other",
        platform: /iPhone|iPad|iPod/.test(ua)
            ? "ios"
            : /Android/.test(ua)
              ? "android"
              : "other",
    };
}

/** Emits client playback telemetry and forwards high-signal events. */
export function logPlaybackClientMetric(
    event: string,
    fields: Record<string, unknown>,
): void {
    if (typeof window === "undefined") {
        return;
    }

    // This observer reports actual advancing audio, not merely a completed load.
    audioEngine.on("timeupdate", reportRecoveryProgress);
    if (
        event === "player.load_autoplay_decision" ||
        event === "player.playback_error"
    )
        pendingRecovery = null;
    if (event === "player.recovery_attempt")
        pendingRecovery = {
            fields,
            position: audioEngine.getActualCurrentTime(),
            at: Date.now(),
        };

    // Engine tags for the native-engine soak (GH #42): engineMode is the
    // deployment flag (cohort), activeEngine is what is actually driving
    // playback at this moment — platform pins make the two legitimately
    // diverge, and the disagreements are themselves diagnostic.
    const activeEngine = audioEngine.getActiveEngineDescriptor();
    let sessionId: string | undefined;
    try {
        sessionId = getRecommendationSessionId();
    } catch {
        // Telemetry must never interfere with playback in restricted storage
        // contexts. The server accepts a missing session id as uncorrelated.
    }
    const isDiagnostic = PLAYBACK_DIAGNOSTIC_EVENTS.has(event);
    const correlatedFields = {
        ...(isDiagnostic ? diagnosticContext() : {}),
        ...fields,
        ...(sessionId ? { sessionId } : {}),
    };
    const safeFields = isDiagnostic
        ? sanitizePlaybackDiagnosticFields(correlatedFields)
        : correlatedFields;
    sharedFrontendLogger.info("[Playback][ClientMetric]", {
        event,
        timestamp: new Date().toISOString(),
        engineMode: resolveStreamingEngineMode(),
        activeEngine,
        ...safeFields,
    });

    // Temporary high-signal beaconing to backend for live stall diagnostics.
    if (!PLAYBACK_CLIENT_SIGNAL_EVENTS.has(event) && !isDiagnostic) {
        return;
    }

    try {
        if (
            queueDiagnostic(isDiagnostic ? event : null, {
                engineMode: resolveStreamingEngineMode(),
                activeEngine,
                ...safeFields,
            })
        )
            return;
    } catch {
        /* A restricted browser still uses the existing best-effort signal. */
    }

    void api
        .reportPlaybackClientMetric({
            event,
            fields: {
                engineMode: resolveStreamingEngineMode(),
                activeEngine,
                ...safeFields,
            },
        })
        .catch(() => undefined);
}

function podcastDebugEnabled(): boolean {
    try {
        return (
            typeof window !== "undefined" &&
            readMigratingStorageItem(PODCAST_DEBUG_STORAGE_KEY) === "1"
        );
    } catch {
        return false;
    }
}

/** Writes opt-in podcast playback diagnostics. */
export function podcastDebugLog(
    message: string,
    data?: Record<string, unknown>,
): void {
    if (!podcastDebugEnabled()) return;
    sharedFrontendLogger.info(`[PodcastDebug] ${message}`, data || {});
}
