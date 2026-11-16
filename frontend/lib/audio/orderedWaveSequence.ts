import type {
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "@/features/home/types";
import type { QueueItem } from "../queue-item";
import { recommendationAdmissionReference } from "./recommendationQueueAdmissionPolicy";
import { snapshotQueueAdmissionReferences } from "./recommendationQueueAdmission";
import { readMusicSourcePlaybackTrack } from "./musicSourcePlayback";

/** Exact server sequence occurrence, without client artist evidence. */
export interface OrderedWaveReference {
    source: "library" | "youtube" | "tidal" | "vk" | "yandex";
    id: string;
    position: number;
}
/** One server-ranked page consumed without lane merging or reshuffling. */
export interface OrderedWavePage {
    version: 1;
    sequenceId: string;
    startPosition: number;
    items: { position: number; track: PersonalizedTrack }[];
    nextCursor: string;
    tail: OrderedWaveReference[];
}
/** Runtime owner and listening intent for a queue checkpoint. */
export interface OrderedWaveOwner {
    authGeneration: number;
    sessionId: string;
    intent: string;
}
/** Bounded continuation captured from the current, unchanged queue. */
export interface OrderedWaveCheckpoint {
    sequenceId: string;
    nextPosition: number;
    nextCursor: string;
    tail: OrderedWaveReference[];
}

function invalid(): never {
    throw new Error("Invalid ordered Wave response");
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return invalid();
    return value as Record<string, unknown>;
}
function integer(value: unknown): number {
    if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 2_147_483_647
    )
        return invalid();
    return value;
}
function reference(
    track: PersonalizedTrack,
): Omit<OrderedWaveReference, "position"> {
    const { source, provider } = track;
    let id: string;
    if (source === "youtube") {
        if (
            typeof provider.youtubeVideoId !== "string" ||
            provider.tidalTrackId != null ||
            track.id !== `yt:${provider.youtubeVideoId}` ||
            (track.youtubeVideoId !== undefined &&
                track.youtubeVideoId !== provider.youtubeVideoId)
        )
            return invalid();
        id = provider.youtubeVideoId;
    } else if (source === "tidal") {
        if (
            typeof provider.tidalTrackId !== "number" ||
            !Number.isSafeInteger(provider.tidalTrackId) ||
            provider.youtubeVideoId != null ||
            (track.id !== `tidal:${provider.tidalTrackId}` &&
                track.id !== String(provider.tidalTrackId))
        )
            return invalid();
        id = String(provider.tidalTrackId);
    } else if (source === "library") {
        if (
            provider.youtubeVideoId != null ||
            provider.tidalTrackId != null ||
            track.youtubeVideoId != null ||
            provider.source !== undefined
        )
            return invalid();
        id = track.id;
    } else if (source === "vk" || source === "yandex") {
        if (
            !readMusicSourcePlaybackTrack(track) ||
            provider.source !== source ||
            typeof provider.providerTrackId !== "string" ||
            track.id !== `${source}:${provider.providerTrackId}`
        )
            return invalid();
        id = provider.providerTrackId;
    } else return invalid();
    if (!snapshotQueueAdmissionReferences([{ source, id }])) return invalid();
    return { source, id };
}
function publicTrack(value: unknown): PersonalizedTrack {
    const row = object(value),
        artist = object(row.artist),
        album = object(row.album),
        provider = object(row.provider);
    if (
        typeof row.id !== "string" ||
        typeof row.title !== "string" ||
        typeof row.duration !== "number" ||
        !Number.isFinite(row.duration) ||
        row.duration < 0 ||
        typeof artist.name !== "string" ||
        (artist.id !== null && typeof artist.id !== "string") ||
        typeof album.title !== "string" ||
        (album.id !== null && typeof album.id !== "string") ||
        (album.coverArt !== null && typeof album.coverArt !== "string") ||
        (row.streamSource !== undefined && row.streamSource !== row.source)
    )
        return invalid();
    const track = {
        id: row.id,
        title: row.title,
        duration: row.duration,
        trackNo: typeof row.trackNo === "number" ? row.trackNo : null,
        artist: { id: artist.id, name: artist.name },
        album: { id: album.id, title: album.title, coverArt: album.coverArt },
        source: row.source,
        streamSource: row.source,
        provider: {
            youtubeVideoId: provider.youtubeVideoId,
            tidalTrackId: provider.tidalTrackId,
            ...(provider.source !== undefined
                ? {
                      source: provider.source,
                      providerTrackId: provider.providerTrackId,
                  }
                : {}),
        },
        ...(row.youtubeVideoId !== undefined
            ? { youtubeVideoId: row.youtubeVideoId }
            : {}),
        ...(row.musicSourceRecording !== undefined
            ? { musicSourceRecording: row.musicSourceRecording }
            : {}),
    } as PersonalizedTrack;
    reference(track);
    return track;
}

/** Absent is legacy; malformed-present data is an error, never a shelf fallback. */
export function readOrderedWavePage(
    feed: Pick<PersonalizedHomeFeed, "orderedWave">,
): OrderedWavePage | undefined {
    if (feed.orderedWave === undefined) return undefined;
    const row = object(feed.orderedWave);
    const keys = [
        "version",
        "sequenceId",
        "startPosition",
        "items",
        "nextCursor",
        "tail",
    ];
    if (
        Object.keys(row).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(row, key)) ||
        row.version !== 1 ||
        typeof row.sequenceId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            row.sequenceId,
        ) ||
        typeof row.nextCursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,1024}$/.test(row.nextCursor) ||
        !Array.isArray(row.items) ||
        row.items.length > 25 ||
        !Array.isArray(row.tail)
    )
        return invalid();
    const startPosition = integer(row.startPosition);
    const nextPosition = integer(startPosition + row.items.length);
    const seen = new Set<string>();
    const items = row.items.map((value, index) => {
        const item = object(value);
        if (
            Object.keys(item).length !== 2 ||
            integer(item.position) !== startPosition + index
        )
            return invalid();
        const track = publicTrack(item.track),
            key = JSON.stringify(reference(track));
        if (seen.has(key)) return invalid();
        seen.add(key);
        return { position: startPosition + index, track };
    });
    const rawTail = row.tail;
    if (rawTail.length !== Math.min(2, nextPosition)) return invalid();
    const tail = rawTail.map((value, index) => {
        const item = object(value);
        if (
            Object.keys(item).length !== 3 ||
            integer(item.position) !== nextPosition - rawTail.length + index ||
            typeof item.id !== "string"
        )
            return invalid();
        const ref = snapshotQueueAdmissionReferences([
            {
                source: item.source as OrderedWaveReference["source"],
                id: item.id,
            },
        ])?.[0];
        if (!ref) return invalid();
        const corresponding = items.find(
            (entry) => entry.position === item.position,
        );
        if (
            corresponding &&
            JSON.stringify(reference(corresponding.track)) !==
                JSON.stringify({ source: ref.source, id: ref.id })
        )
            return invalid();
        return {
            source: ref.source,
            id: ref.id,
            position: item.position as number,
        };
    });
    return {
        version: 1,
        sequenceId: row.sequenceId,
        startPosition,
        items,
        nextCursor: row.nextCursor,
        tail,
    };
}

/** Queue array identity and all recording positions fence every manual mutation. */
export class OrderedWaveQueueCheckpoints {
    private readonly entries = new WeakMap<
        readonly QueueItem[],
        { owner: string; signature: string; checkpoint: OrderedWaveCheckpoint }
    >();
    private signature(queue: readonly QueueItem[]): string | undefined {
        const refs = queue.map((item) =>
            recommendationAdmissionReference(item),
        );
        if (refs.some((ref) => ref === null)) return undefined;
        return JSON.stringify(refs.map((ref) => [ref!.source, ref!.id]));
    }
    commit(
        queue: readonly QueueItem[],
        page: OrderedWavePage,
        owner: OrderedWaveOwner,
    ): boolean {
        this.invalidate(queue);
        const signature = this.signature(queue);
        if (signature === undefined || queue.length < page.items.length)
            return false;
        const suffix = queue.slice(queue.length - page.items.length);
        if (
            page.items.some((item, index) => {
                const actual = recommendationAdmissionReference(suffix[index]),
                    expected = reference(item.track);
                return (
                    !actual ||
                    actual.source !== expected.source ||
                    actual.id !== expected.id
                );
            })
        )
            return false;
        const tail = queue.slice(-page.tail.length);
        if (
            page.tail.some((expected, index) => {
                const actual = recommendationAdmissionReference(tail[index]);
                return (
                    !actual ||
                    actual.source !== expected.source ||
                    actual.id !== expected.id
                );
            })
        )
            return false;
        this.entries.set(queue, {
            owner: JSON.stringify(owner),
            signature,
            checkpoint: {
                sequenceId: page.sequenceId,
                nextPosition: page.startPosition + page.items.length,
                nextCursor: page.nextCursor,
                tail: page.tail.map((row) => ({ ...row })),
            },
        });
        return true;
    }
    capture(
        queue: readonly QueueItem[],
        owner: OrderedWaveOwner,
        shuffled = false,
    ): OrderedWaveCheckpoint | undefined {
        const entry = this.entries.get(queue);
        if (
            !entry ||
            shuffled ||
            entry.owner !== JSON.stringify(owner) ||
            entry.signature !== this.signature(queue)
        ) {
            this.invalidate(queue);
            return undefined;
        }
        return structuredClone(entry.checkpoint);
    }
    invalidate(queue: readonly QueueItem[]): void {
        this.entries.delete(queue);
    }
}

export const orderedWaveQueueCheckpoints = new OrderedWaveQueueCheckpoints();
