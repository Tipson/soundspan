/** Runtime capabilities needed by the Android local-file transport. */
export interface ContinuousAudioCapabilities {
    userAgent: string;
    mediaSource: boolean;
    changeType: boolean;
    audioType: boolean;
}

/** Other platforms and unsupported containers retain the direct native path. */
export function supportsContinuousAndroidPlayback(
    capabilities?: ContinuousAudioCapabilities,
): boolean {
    const current = capabilities ?? {
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        mediaSource: typeof MediaSource !== "undefined",
        changeType:
            typeof SourceBuffer !== "undefined" &&
            typeof SourceBuffer.prototype.changeType === "function",
        audioType:
            typeof MediaSource !== "undefined" &&
            (MediaSource.isTypeSupported("audio/mpeg") ||
                MediaSource.isTypeSupported('audio/webm;codecs="opus"')),
    };
    return (
        /Android/i.test(current.userAgent) &&
        current.mediaSource &&
        current.changeType &&
        current.audioType
    );
}
