import { api } from "@/lib/api";
import { createRuntimeAudioEngine } from "@/lib/audio-engine";
import { resolveStreamingEngineMode } from "@/lib/audio-engine/engineMode";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    PODCAST_DEBUG_STORAGE_KEY,
    readMigratingStorageItem,
} from "@/lib/storage-migration";
import { getRecommendationSessionId } from "@/lib/recommendationSession";

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

/** Emits client playback telemetry and forwards high-signal events. */
export function logPlaybackClientMetric(
    event: string,
    fields: Record<string, unknown>,
): void {
    if (typeof window === "undefined") {
        return;
    }

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
    const correlatedFields = {
        ...fields,
        ...(sessionId ? { sessionId } : {}),
    };
    sharedFrontendLogger.info("[Playback][ClientMetric]", {
        event,
        timestamp: new Date().toISOString(),
        engineMode: resolveStreamingEngineMode(),
        activeEngine,
        ...correlatedFields,
    });

    // Temporary high-signal beaconing to backend for live stall diagnostics.
    if (!PLAYBACK_CLIENT_SIGNAL_EVENTS.has(event)) {
        return;
    }

    void api
        .reportPlaybackClientMetric({
            event,
            fields: {
                engineMode: resolveStreamingEngineMode(),
                activeEngine,
                ...correlatedFields,
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
