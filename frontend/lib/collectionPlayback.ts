import { getPlaybackReplacementGeneration } from "./audio-engine/playbackAdvanceOrigin";

let activeCollection: { id: string; generation: number } | null = null;

/** Mark immediately after a collection starts playback; survives client-side navigation. */
export function markCollectionPlayback(
    id: string,
    previousGeneration: number,
): void {
    if (previousGeneration === getPlaybackReplacementGeneration()) return;
    activeCollection = { id, generation: getPlaybackReplacementGeneration() };
}

/** Pause/seek/next retain ownership; replacing the queue invalidates it. */
export function isCollectionPlayback(id: string): boolean {
    return (
        activeCollection?.id === id &&
        activeCollection.generation === getPlaybackReplacementGeneration()
    );
}

/** Capture before asking controls to start a collection; rejected starts retain the generation. */
export function getCollectionPlaybackGeneration(): number {
    return getPlaybackReplacementGeneration();
}
