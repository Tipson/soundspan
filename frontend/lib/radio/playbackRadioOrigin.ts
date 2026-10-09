import {
    normalizePlaybackRadioOrigin,
    type PlaybackRadioOrigin,
} from "@soundspan/media-metadata-contract";

/** Applies an explicit station intent, removing stale intent on collection starts. */
export function withPlaybackRadioOrigin<
    T extends { radioOrigin?: PlaybackRadioOrigin },
>(track: T, value?: PlaybackRadioOrigin | null): T {
    const radioOrigin = normalizePlaybackRadioOrigin(value);
    if (!radioOrigin && track.radioOrigin === undefined) return track;
    const { radioOrigin: previousOrigin, ...rest } = track;
    void previousOrigin;
    return { ...rest, ...(radioOrigin ? { radioOrigin } : {}) } as T;
}
