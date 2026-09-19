/** A locally owned recording, already checked for container support. */
export interface ContinuousAudioSource {
    id: string;
    url: string;
    blob: Blob;
    mime: string;
    durationSec: number;
}

/** Serialized subset of SourceBuffer used by the continuous transport. */
export interface AudioSequenceBuffer {
    readonly buffered: Pick<TimeRanges, "length" | "start" | "end">;
    readonly updating: boolean;
    mode: SourceBuffer["mode"];
    timestampOffset: number;
    appendBuffer(bytes: ArrayBuffer): void;
    remove(start: number, end: number): void;
    abort(): void;
    changeType(mime: string): void;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
}

/** Dependencies and byte/time bounds; no queue selection lives in this layer. */
export interface ContinuousAudioBufferOptions {
    buffer: AudioSequenceBuffer;
    current: ContinuousAudioSource;
    readPosition: () => number;
    onBoundary: (endedSourceId: string) => void;
    onNextReady: (sourceId: string) => void;
    chunkBytes?: number;
    aheadSec?: number;
    behindSec?: number;
}

interface Segment {
    source: ContinuousAudioSource;
    offset: number;
    startSec: number | null;
    endSec: number | null;
    boundarySent: boolean;
    readySent: boolean;
}

const segment = (
    source: ContinuousAudioSource,
    startSec: number | null,
): Segment => ({
    source,
    startSec,
    endSec: null,
    offset: 0,
    boundarySent: false,
    readySent: false,
});

/**
 * Keeps current/next recordings on one bounded native media timeline.
 * The owner calls pump/checkBoundary from native timeupdate and waiting events.
 * This class never starts playback or changes an HTMLAudioElement's source.
 */
export class ContinuousAudioBuffer {
    private active: Segment | null;
    private next: Segment | null = null;
    private pruneFrom: number | null = null;
    private running: Promise<void> | null = null;
    private cancelUpdate: (() => void) | null = null;
    private generation = 0;
    private disposed = false;
    private fillPosition: number | null = null;
    private mime: string;
    private readonly chunkBytes: number;
    private readonly aheadSec: number;
    private readonly behindSec: number;
    private readonly options: Omit<ContinuousAudioBufferOptions, "current">;

    constructor(options: ContinuousAudioBufferOptions) {
        // Retaining the constructor's `current` in options would pin the first
        // recording even after the physical timeline has adopted its successor.
        this.options = {
            buffer: options.buffer,
            readPosition: options.readPosition,
            onBoundary: options.onBoundary,
            onNextReady: options.onNextReady,
        };
        this.active = segment(options.current, 0);
        this.mime = options.current.mime;
        this.chunkBytes = options.chunkBytes ?? 65_536;
        this.aheadSec = options.aheadSec ?? 30;
        this.behindSec = options.behindSec ?? 15;
        if (
            !Number.isInteger(this.chunkBytes) ||
            this.chunkBytes <= 0 ||
            !Number.isFinite(this.aheadSec) ||
            this.aheadSec <= 0 ||
            !Number.isFinite(this.behindSec) ||
            this.behindSec < 0
        ) {
            throw new Error("Invalid continuous audio buffer bounds");
        }
        options.buffer.mode = "sequence";
    }

    /** Physical active source and its position on the shared timeline. */
    get current() {
        if (!this.active) throw new Error("Continuous audio buffer disposed");
        return {
            ...this.active.source,
            startSec: this.active.startSec ?? 0,
            endSec: this.active.endSec,
        };
    }

    /** All caller-supplied recordings are appended; the owner may end the stream. */
    get exhausted(): boolean {
        return Boolean(
            this.active &&
            this.active.endSec !== null &&
            (!this.next || this.next.endSec !== null) &&
            this.pruneFrom === null,
        );
    }

    /** Stages exactly the caller-selected next source, replacing any old lease. */
    stageNext(source: ContinuousAudioSource): void {
        if (this.disposed) return;
        if (this.next?.source.id === source.id) return;
        if (this.next) this.cancelNext(this.next.source.id);
        this.next = segment(source, null);
    }

    /** Cancellation cannot remove a source already adopted at a natural boundary. */
    cancelNext(id: string): void {
        if (this.next?.source.id !== id) return;
        if (this.next.startSec !== null) {
            this.pruneFrom = Math.min(
                this.pruneFrom ?? Infinity,
                this.next.startSec,
            );
        }
        this.next = null;
    }

    /** Advances ownership once, while the native timeline continues uninterrupted. */
    checkBoundary(): void {
        const active = this.active;
        if (
            !active ||
            active.boundarySent ||
            active.endSec === null ||
            this.options.readPosition() < active.endSec - 0.01
        )
            return;
        active.boundarySent = true;
        if (this.next?.readySent) {
            this.active = this.next;
            this.next = null;
        }
        this.options.onBoundary(active.source.id);
    }

    /** Fills at most the configured lookahead plus one bounded byte chunk. */
    pump(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.running) return this.running;
        return this.track(this.fill(this.generation));
    }

    /** Rebuilds retained ranges from local bytes for an arbitrary track-relative seek. */
    seek(timeSec: number): Promise<void> {
        if (!this.active || this.disposed || !Number.isFinite(timeSec))
            return Promise.resolve();
        const target = Math.max(
            0,
            Math.min(timeSec, this.active.source.durationSec),
        );
        const generation = ++this.generation;
        const previous = this.running;
        return this.track(this.refill(target, generation, previous));
    }

    private track(operation: Promise<void>): Promise<void> {
        const tracked = operation.finally(() => {
            if (this.running === tracked) this.running = null;
        });
        this.running = tracked;
        return tracked;
    }

    private async refill(
        target: number,
        generation: number,
        previous: Promise<void> | null,
    ): Promise<void> {
        await previous?.catch(() => undefined);
        if (this.disposed || generation !== this.generation || !this.active)
            return;
        if (this.options.buffer.buffered.length) {
            await this.update(() => this.options.buffer.remove(0, Infinity));
        }
        if (this.disposed || generation !== this.generation) return;
        this.options.buffer.abort();
        this.options.buffer.timestampOffset = 0;
        this.active = segment(this.active.source, 0);
        if (this.next) this.next = segment(this.next.source, null);
        this.pruneFrom = null;
        this.fillPosition = target;
        try {
            await this.fill(generation);
        } finally {
            if (generation === this.generation) this.fillPosition = null;
        }
    }

    /** Invalidates pending reads and removes update listeners without reviving audio. */
    dispose(): void {
        this.disposed = true;
        this.generation++;
        this.cancelUpdate?.();
        this.active = null;
        this.next = null;
        try {
            this.options.buffer.abort();
        } catch {
            /* Detached media source. */
        }
    }

    private end(): number {
        const ranges = this.options.buffer.buffered;
        return ranges.length ? ranges.end(ranges.length - 1) : 0;
    }

    private async fill(generation: number): Promise<void> {
        while (
            !this.disposed &&
            generation === this.generation &&
            this.active
        ) {
            if (this.pruneFrom !== null) {
                const from = this.pruneFrom;
                this.pruneFrom = null;
                await this.update(() =>
                    this.options.buffer.remove(from, Infinity),
                );
                if (this.disposed || generation !== this.generation) return;
                this.options.buffer.abort();
                this.options.buffer.timestampOffset = from;
                continue;
            }
            const position = this.fillPosition ?? this.options.readPosition();
            const ranges = this.options.buffer.buffered;
            const retainFrom = Math.max(
                0,
                Math.min(position, this.end()) - this.behindSec,
            );
            if (ranges.length && ranges.start(0) < retainFrom) {
                await this.update(() =>
                    this.options.buffer.remove(0, retainFrom),
                );
                if (this.disposed || generation !== this.generation) return;
            }
            if (this.end() - position >= this.aheadSec) return;
            const target =
                this.active.endSec === null ? this.active : this.next;
            if (!target || target.endSec !== null) return;
            if (!target.source.blob.size)
                throw new Error("Empty continuous audio source");
            if (target.startSec === null) target.startSec = this.active.endSec;
            const bytes = await target.source.blob
                .slice(target.offset, target.offset + this.chunkBytes)
                .arrayBuffer();
            if (this.disposed || generation !== this.generation) return;
            if (target !== this.active && target !== this.next) continue;
            if (!bytes.byteLength)
                throw new Error("Empty continuous audio chunk");
            if (this.mime !== target.source.mime) {
                this.options.buffer.changeType(target.source.mime);
                this.mime = target.source.mime;
            }
            await this.update(() => this.options.buffer.appendBuffer(bytes));
            if (this.disposed || generation !== this.generation) return;
            target.offset += bytes.byteLength;
            if (target.offset >= target.source.blob.size) {
                const end = this.end();
                if (end <= (target.startSec ?? 0))
                    throw new Error("Audio source produced no frames");
                target.endSec = end;
            }
            if (
                target === this.next &&
                !target.readySent &&
                this.end() > (target.startSec ?? Infinity)
            ) {
                target.readySent = true;
                this.options.onNextReady(target.source.id);
            }
        }
    }

    private update(action: () => void): Promise<void> {
        return new Promise((resolve, reject) => {
            const buffer = this.options.buffer;
            const cleanup = () => {
                buffer.removeEventListener("updateend", done);
                buffer.removeEventListener("error", failed);
                this.cancelUpdate = null;
            };
            const done = () => {
                cleanup();
                resolve();
            };
            const failed = () => {
                cleanup();
                reject(new Error("Continuous audio buffer update failed"));
            };
            this.cancelUpdate = done;
            buffer.addEventListener("updateend", done);
            buffer.addEventListener("error", failed);
            try {
                action();
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    }
}
