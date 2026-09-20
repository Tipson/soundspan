import type { Track as AudioTrack } from "@/lib/audio-state-context";
import type { Track } from "./types";
import { mergeArtistTracks } from "./artistView";

/** Append unseen artist pages only while the initiating ordered queue is owned. */
export async function extendArtistPlayback(options: {
    initialTracks: Track[];
    initialQueue: AudioTrack[];
    pages: AsyncIterable<Track[]>;
    isCurrent: () => boolean;
    getQueueIds: () => string[];
    formatTrack: (track: Track) => AudioTrack | null;
    append: (tracks: AudioTrack[]) => void;
}): Promise<"completed" | "cancelled" | "fetch-failed"> {
    let known = options.initialTracks;
    let expected = options.initialQueue.map((track) => track.id);
    const owned = () => {
        const actual = options.getQueueIds();
        return (
            options.isCurrent() &&
            actual.length === expected.length &&
            actual.every((id, index) => id === expected[index])
        );
    };
    try {
        for await (const page of options.pages) {
            if (!owned()) return "cancelled";
            const merged = mergeArtistTracks(known, page);
            const added = merged.slice(known.length).flatMap((track) => {
                const audio = options.formatTrack(track);
                return audio ? [audio] : [];
            });
            known = merged;
            if (added.length) {
                options.append(added);
                expected = [...expected, ...added.map((track) => track.id)];
            }
        }
        return owned() ? "completed" : "cancelled";
    } catch {
        return owned() ? "fetch-failed" : "cancelled";
    }
}
