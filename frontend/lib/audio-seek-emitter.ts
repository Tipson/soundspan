/**
 * Simple event emitter for seeking without causing re-renders
 * This allows the seek() function to communicate with AudioElement
 * without subscribing to currentTime state changes
 */

import {
    recordExplicitPlaybackSeek,
    type PlaybackCommandOrigin,
} from "./audio-engine/playbackAdvanceOrigin";

type SeekListener = (time: number) => void;

class AudioSeekEmitter {
    private listeners: Set<SeekListener> = new Set();

    public subscribe(listener: SeekListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    public emit(time: number, origin: PlaybackCommandOrigin = "manual"): void {
        recordExplicitPlaybackSeek(origin);
        this.listeners.forEach((listener) => listener(time));
    }
}

export const audioSeekEmitter = new AudioSeekEmitter();
