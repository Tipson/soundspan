/** An ephemeral final skip; only a real server acknowledgement may commit it. */
export interface AdaptiveWaveSkipReceipt {
    commit(): void;
    abandon(): void;
}

/** Capture the station while playback starts, before a later transition or POST response. */
export type AdaptiveWaveSkipCapture = () => AdaptiveWaveSkipReceipt | null;

interface Owner {
    capture(): AdaptiveWaveSkipCapture | null;
}

let current: { owner: Owner } | null = null;

/** Register from the mounted solo player; stale cleanup cannot retire a newer owner. */
export function registerAdaptiveWaveFeedbackOwner(owner: Owner): () => void {
    const registration = { owner };
    current = registration;
    return () => {
        if (current === registration) current = null;
    };
}

/** A delayed finalization can never adopt a replacement player or station. */
export function captureAdaptiveWaveSkipOwner(): AdaptiveWaveSkipCapture | null {
    const registration = current;
    const capture = registration?.owner.capture();
    if (!registration || !capture) return null;
    return () => (current === registration ? capture() : null);
}
