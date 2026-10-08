"use client";

import {
    useCallback,
    useLayoutEffect,
    useMemo,
    useRef,
    type ComponentProps,
} from "react";
import { useAudioControls } from "@/lib/audio-controls-context";
import {
    getPlaybackReplacementGeneration,
    getQueueReplacementGeneration,
} from "@/lib/audio-engine/playbackAdvanceOrigin";
import { TrackPreferenceButtons } from "./TrackPreferenceButtons";

type CurrentTrackPreferenceButtonsProps = Omit<
    ComponentProps<typeof TrackPreferenceButtons>,
    "onThumbsDownApplied"
>;

/**
 * Preference controls for the active player surface. A confirmed dislike
 * advances with the feedback policy (which bypasses repeat-one), but a late
 * response cannot skip whichever track the user selected in the meantime or
 * take over playback after these controls leave the player or the queue changes.
 */
export function CurrentTrackPreferenceButtons(
    props: CurrentTrackPreferenceButtonsProps,
) {
    const { advanceQueue } = useAudioControls();
    const replacementGeneration = getPlaybackReplacementGeneration();
    const queueGeneration = getQueueReplacementGeneration();
    const callbackIdentity = useMemo(
        () => ({
            trackId: props.trackId,
            advanceQueue,
            replacementGeneration,
            queueGeneration,
        }),
        [props.trackId, advanceQueue, replacementGeneration, queueGeneration],
    );
    const activeCallbackRef = useRef<typeof callbackIdentity | null>(
        callbackIdentity,
    );

    useLayoutEffect(() => {
        activeCallbackRef.current = callbackIdentity;
        return () => {
            activeCallbackRef.current = null;
        };
    }, [callbackIdentity]);

    const handleThumbsDownApplied = useCallback(
        (appliedTrackId: string) => {
            if (
                activeCallbackRef.current !== callbackIdentity ||
                callbackIdentity.trackId !== appliedTrackId ||
                callbackIdentity.replacementGeneration !==
                    getPlaybackReplacementGeneration() ||
                callbackIdentity.queueGeneration !==
                    getQueueReplacementGeneration()
            )
                return;
            callbackIdentity.advanceQueue("feedback");
        },
        [callbackIdentity],
    );

    return (
        <TrackPreferenceButtons
            {...props}
            onThumbsDownApplied={handleThumbsDownApplied}
        />
    );
}
