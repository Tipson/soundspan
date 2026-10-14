import type { ApiData } from "./core";

/** User-command generation; clock ticks and server adoption retain this authority. */
export interface PlaybackStateAuthority {
    commandGeneration: number;
}

/** Immutable CAS receipt for one authenticated browser-device slot. */
export interface PlaybackStateRevision {
    readonly etag: string;
    readonly authGeneration: number;
    readonly deviceId: string;
}

/** A read's payload and its own receipt, including absent and cleared slots. */
export interface PlaybackStateSnapshot {
    state: ApiData;
    revision: PlaybackStateRevision | null;
}

/** Payload saved for the selected medium; the server limits queue size. */
export interface PlaybackStateInput {
    playbackType: string;
    trackId?: string;
    audiobookId?: string;
    podcastId?: string;
    queue?: ApiData[];
    currentIndex?: number;
    isShuffle?: boolean;
    isPlaying?: boolean;
    currentTime?: number;
}

interface Mutation {
    kind: "save" | "clear";
    state?: PlaybackStateInput;
    authority: number | null;
    snapshot?: PlaybackStateSnapshot;
    conflictEpoch: number;
    finish: (value: ApiData) => void;
    fail: (error: unknown) => void;
}

/** Validate only the explicitly advertised CAS protocol, never Express ETags. */
export function readPlaybackStateRevision(
    headers: Headers,
    authGeneration: number,
    deviceId: string,
): PlaybackStateRevision | null {
    const etag = headers.get("ETag");
    if (
        headers.get("X-Playback-State-Protocol") !== "1" ||
        !etag ||
        !/^"ps1\.(?:absent|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"$/.test(
            etag,
        )
    )
        return null;
    return Object.freeze({ etag, authGeneration, deviceId });
}

function authorityKey(authority?: PlaybackStateAuthority): number | null {
    return authority?.commandGeneration ?? null;
}

/** Serializes CAS writes within one auth/device scope and fences stale writers. */
export class PlaybackStateCoordinator {
    lease: PlaybackStateRevision | null = null;
    leaseKnown = false;
    writeEpoch = 0;
    readSequence = 0;
    acceptedReadSequence = 0;
    private running = false;
    private pending: Mutation[] = [];
    private blockedThroughCommandGeneration = -1;
    private defaultAuthorityBlocked = false;
    private conflictEpoch = 0;
    private latestAuthority: number | null = null;
    private lastReadState: ApiData;

    constructor(
        readonly authGeneration: number,
        readonly deviceId: string,
        private readonly current: () => boolean,
        private readonly read: () => Promise<PlaybackStateSnapshot>,
        private readonly mutate: (
            kind: "save" | "clear",
            revision: PlaybackStateRevision,
            state?: PlaybackStateInput,
        ) => Promise<{
            state: ApiData;
            revision: PlaybackStateRevision | null;
        }>,
    ) {}

    acceptRead(
        sequence: number,
        epoch: number,
        snapshot: PlaybackStateSnapshot,
    ): void {
        if (
            !this.current() ||
            epoch !== this.writeEpoch ||
            sequence < this.acceptedReadSequence
        )
            return;
        this.acceptedReadSequence = sequence;
        this.leaseKnown = true;
        this.lease = snapshot.revision;
        this.lastReadState = snapshot.state;
    }

    private isBlocked(authority: number | null): boolean {
        return authority === null
            ? this.defaultAuthorityBlocked
            : authority <= this.blockedThroughCommandGeneration;
    }

    save(
        state: PlaybackStateInput,
        authority?: PlaybackStateAuthority,
    ): Promise<ApiData> {
        const key = authorityKey(authority);
        this.latestAuthority = key;
        if (this.isBlocked(key)) return Promise.resolve(undefined);
        const last = this.pending.at(-1);
        if (last?.kind === "save") {
            this.pending.pop();
            last.finish(undefined);
        }
        // Serialize the payload now: callers may replace or edit their queue later.
        return this.enqueue({
            kind: "save",
            state: JSON.parse(JSON.stringify(state)),
            authority: key,
        });
    }

    clear(snapshot?: PlaybackStateSnapshot): Promise<boolean> {
        if (snapshot && !this.owns(snapshot.revision))
            return Promise.resolve(false);
        if (!snapshot) {
            this.pending = this.pending.filter((task) => {
                if (task.kind !== "save") return true;
                task.finish(undefined);
                return false;
            });
        }
        return this.enqueue({
            kind: "clear",
            snapshot,
            authority: this.latestAuthority,
        });
    }

    retire(): void {
        for (const task of this.pending) task.finish(undefined);
        this.pending = [];
    }

    private owns(
        revision: PlaybackStateRevision | null,
    ): revision is PlaybackStateRevision {
        return Boolean(
            this.current() &&
            revision &&
            revision.authGeneration === this.authGeneration &&
            revision.deviceId === this.deviceId,
        );
    }

    private enqueue(
        input: Omit<Mutation, "finish" | "fail" | "conflictEpoch">,
    ): Promise<ApiData> {
        const promise = new Promise<ApiData>((finish, fail) => {
            this.pending.push({
                ...input,
                finish,
                fail,
                conflictEpoch: this.conflictEpoch,
            });
        });
        void this.drain();
        return promise;
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.pending.length > 0) {
                const task = this.pending.shift()!;
                try {
                    if (
                        !this.current() ||
                        (task.kind === "save" &&
                            this.isBlocked(task.authority)) ||
                        (task.kind === "clear" &&
                            !task.snapshot &&
                            task.conflictEpoch !== this.conflictEpoch)
                    ) {
                        task.finish(task.kind === "clear" ? false : undefined);
                        continue;
                    }
                    if (!task.snapshot && !this.leaseKnown) await this.read();
                    // Cleanup of an older read is already obsolete when our own
                    // coordinator knows a different revision. Never substitute
                    // that newer receipt or manufacture a conflict against it.
                    if (
                        task.snapshot &&
                        this.lease &&
                        task.snapshot.revision?.etag !== this.lease.etag
                    ) {
                        task.finish(false);
                        continue;
                    }
                    const revision = task.snapshot
                        ? task.snapshot.revision
                        : this.lease;
                    if (!this.owns(revision)) {
                        task.finish(task.kind === "clear" ? false : undefined);
                        continue;
                    }
                    let state = task.state;
                    // An absent own slot can be backed by a read-only legacy row.
                    // Its first write must carry the queue as well as partial progress.
                    if (state && revision.etag === '"ps1.absent"') {
                        state = {
                            ...state,
                            queue:
                                state.queue ?? this.lastReadState?.queue ?? [],
                            currentIndex:
                                state.currentIndex ??
                                this.lastReadState?.currentIndex ??
                                0,
                        };
                    }
                    this.writeEpoch++;
                    try {
                        const result = await this.mutate(
                            task.kind,
                            revision,
                            state,
                        );
                        if (!this.current()) {
                            task.finish(
                                task.kind === "clear" ? false : undefined,
                            );
                            continue;
                        }
                        this.lease = result.revision;
                        this.leaseKnown = true;
                        task.finish(
                            task.kind === "clear" ? true : result.state,
                        );
                    } finally {
                        this.writeEpoch++;
                    }
                } catch (error) {
                    if ((error as { status?: number })?.status === 412) {
                        this.lease = null;
                        this.leaseKnown = false;
                        this.conflictEpoch++;
                        if (task.authority === null)
                            this.defaultAuthorityBlocked = true;
                        else
                            this.blockedThroughCommandGeneration = Math.max(
                                this.blockedThroughCommandGeneration,
                                task.authority,
                            );
                        this.pending = this.pending.filter((pending) => {
                            if (
                                pending.kind !== "save" ||
                                !this.isBlocked(pending.authority)
                            )
                                return true;
                            pending.finish(undefined);
                            return false;
                        });
                    }
                    task.fail(error);
                }
            }
        } finally {
            this.running = false;
        }
    }
}
