"use client";

import {
    useCallback,
    useLayoutEffect,
    useRef,
    type ComponentProps,
} from "react";
import { useAudioControls } from "@/lib/audio-controls-context";
import { TrackPreferenceButtons } from "./TrackPreferenceButtons";

type CurrentTrackPreferenceButtonsProps = Omit<
    ComponentProps<typeof TrackPreferenceButtons>,
    "onThumbsDownApplied"
>;

/**
 * Preference controls for the active player surface. A confirmed dislike
 * advances with the feedback policy (which bypasses repeat-one), but a late
 * response cannot skip whichever track the user selected in the meantime.
 */
export function CurrentTrackPreferenceButtons(
    props: CurrentTrackPreferenceButtonsProps,
) {
    const { advanceQueue } = useAudioControls();
    const activeTrackIdRef = useRef(props.trackId);

    useLayoutEffect(() => {
        activeTrackIdRef.current = props.trackId;
    }, [props.trackId]);

    const handleThumbsDownApplied = useCallback(
        (appliedTrackId: string) => {
            if (activeTrackIdRef.current !== appliedTrackId) return;
            advanceQueue("feedback");
        },
        [advanceQueue],
    );

    return (
        <TrackPreferenceButtons
            {...props}
            onThumbsDownApplied={handleThumbsDownApplied}
        />
    );
}
