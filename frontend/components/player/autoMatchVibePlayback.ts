import type { VibeQueueMutationKind } from "@/lib/audio-controls-types";

export interface AutoMatchVibeQueueEndInput {
    playbackType: "track" | "audiobook" | "podcast" | null;
    queueLength: number;
    currentIndex: number;
    repeatMode: "off" | "one" | "all";
    isListenTogether: boolean;
    isShuffle?: boolean;
    shuffleIndices?: readonly number[];
}

/**
 * Executes shouldAutoMatchVibeAtQueueEnd.
 */
export function shouldAutoMatchVibeAtQueueEnd(
    input: AutoMatchVibeQueueEndInput,
): boolean {
    if (input.playbackType !== "track") return false;
    if (input.isListenTogether) return false;
    if (input.repeatMode !== "off") return false;
    if (input.queueLength <= 0) return false;

    if (input.isShuffle && input.shuffleIndices?.includes(input.currentIndex)) {
        return (
            input.shuffleIndices.indexOf(input.currentIndex) ===
            input.shuffleIndices.length - 1
        );
    }

    return input.currentIndex >= input.queueLength - 1;
}

/** Queue result from one generation-fenced automatic Match Vibe request. */
export type AutoMatchVibeRequestResult =
    | { didExtendQueue: false; queueMutation: null }
    | {
          didExtendQueue: true;
          queueMutation: VibeQueueMutationKind;
      };
