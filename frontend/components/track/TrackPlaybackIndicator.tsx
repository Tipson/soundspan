"use client";

import { usePlaybackStatus } from "@/lib/audio-playback-context";

/** Shared, non-ticking playback marker beside the current track's title. */
export function TrackPlaybackIndicator({ playing }: { playing: boolean }) {
    return (
        <span
            data-playback-state={playing ? "playing" : "paused"}
            aria-label={playing ? "Играет" : "На паузе"}
            role="img"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center gap-0.5 text-brand"
        >
            {[0, 1, 2].map((bar) => (
                <span
                    key={bar}
                    aria-hidden="true"
                    className={`w-0.5 rounded-full bg-current ${playing ? "motion-safe:animate-bounce" : ""}`}
                    style={{
                        height: [8, 12, 6][bar],
                        animationDelay: `${bar * -0.2}s`,
                    }}
                />
            ))}
        </span>
    );
}

/** Mount only for the selected track; progress ticks do not rerender the list. */
export function CurrentTrackPlaybackIndicator() {
    const { isPlaying } = usePlaybackStatus();
    return <TrackPlaybackIndicator playing={isPlaying} />;
}
