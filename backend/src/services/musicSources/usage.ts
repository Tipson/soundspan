import { MusicSourceError, type MusicSource } from "./types";

function emptyUsage() {
    return {
        resolutionAttempts: 0,
        selected: 0,
        noMatch: 0,
        resolutionFailed: 0,
        resolutionCancelled: 0,
        streamRequests: 0,
        streamCompleted: 0,
        streamFailed: 0,
        streamCancelled: 0,
        lastFailure: null as string | null,
    };
}

/** Fixed-cardinality, process-local HTTP transport counts, never listening history. */
export function createMusicSourceUsage(since: number) {
    const providers = { yandex: emptyUsage(), vk: emptyUsage() };
    const record = (
        provider: MusicSource,
        field: keyof Omit<ReturnType<typeof emptyUsage>, "lastFailure">,
    ) => {
        providers[provider][field] = Math.min(
            Number.MAX_SAFE_INTEGER,
            providers[provider][field] + 1,
        );
    };
    return {
        resolutionStarted(provider: MusicSource) {
            record(provider, "resolutionAttempts");
        },
        resolutionFinished(
            provider: MusicSource,
            outcome:
                | "selected"
                | "noMatch"
                | "resolutionFailed"
                | "resolutionCancelled",
            error?: unknown,
        ) {
            record(provider, outcome);
            if (outcome === "resolutionFailed")
                providers[provider].lastFailure =
                    error instanceof MusicSourceError
                        ? error.code
                        : "unavailable";
        },
        streamStarted(provider: MusicSource) {
            record(provider, "streamRequests");
        },
        streamFinished(
            provider: MusicSource,
            outcome: "streamCompleted" | "streamFailed" | "streamCancelled",
            error?: unknown,
        ) {
            record(provider, outcome);
            if (outcome === "streamFailed")
                providers[provider].lastFailure =
                    error instanceof MusicSourceError
                        ? error.code
                        : "unavailable";
        },
        snapshot() {
            return {
                since,
                providers: {
                    yandex: { ...providers.yandex },
                    vk: { ...providers.vk },
                },
            };
        },
    };
}
