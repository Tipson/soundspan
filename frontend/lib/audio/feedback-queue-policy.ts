import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";

interface FeedbackQueue {
    queue: QueueItem[];
    currentIndex: number;
    shuffleIndices: number[];
}

/** Keep played history while dropping later recommendations by the disliked artist. */
export function pruneRecommendedArtistAfterDislike(input: {
    queue: QueueItem[];
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: number[];
    artistName: string;
}): FeedbackQueue {
    const artist = input.artistName.trim().toLocaleLowerCase();
    if (!artist || artist === "unknown artist") return input;

    const shufflePosition = input.isShuffle
        ? input.shuffleIndices.indexOf(input.currentIndex)
        : -1;
    const upcoming =
        shufflePosition >= 0
            ? new Set(input.shuffleIndices.slice(shufflePosition + 1))
            : null;
    const oldToNew = new Map<number, number>();
    const queue = input.queue.filter((item, index) => {
        const isUpcoming = upcoming
            ? upcoming.has(index)
            : index > input.currentIndex;
        const sameArtist =
            !isEpisodeQueueItem(item) &&
            item.artist.name.trim().toLocaleLowerCase() === artist;
        if (isUpcoming && sameArtist) return false;
        oldToNew.set(index, oldToNew.size);
        return true;
    });
    if (queue.length === input.queue.length) return input;

    return {
        queue,
        currentIndex: oldToNew.get(input.currentIndex) ?? input.currentIndex,
        shuffleIndices: input.shuffleIndices.flatMap((index) => {
            const next = oldToNew.get(index);
            return next === undefined ? [] : [next];
        }),
    };
}
