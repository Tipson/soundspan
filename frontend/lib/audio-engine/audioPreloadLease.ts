import type {
    AudioPreloadLease,
    AudioPreloadResult,
} from "@/lib/audio-engine/types";

export interface AudioPreloadLeaseController {
    readonly lease: AudioPreloadLease;
    settle(result: AudioPreloadResult): void;
}

/**
 * Creates a never-rejecting readiness lease. Cancellation releases the owned
 * resource even after readiness has settled, without rewriting that result.
 */
export const createAudioPreloadLease = (
    sourceUrl: string,
    onCancel: () => void,
): AudioPreloadLeaseController => {
    let settled = false;
    let released = false;
    let resolveResult!: (result: AudioPreloadResult) => void;
    const result = new Promise<AudioPreloadResult>((resolve) => {
        resolveResult = resolve;
    });

    const settle = (value: AudioPreloadResult): void => {
        if (settled) {
            return;
        }
        settled = true;
        resolveResult(value);
    };

    const lease: AudioPreloadLease = {
        sourceUrl,
        result,
        cancel: () => {
            if (released) {
                return;
            }
            released = true;
            onCancel();
            settle({ state: "cancelled" });
        },
    };

    return { lease, settle };
};
