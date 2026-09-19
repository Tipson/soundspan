import {
    languageCacheKey,
    type LanguageRecording,
    type RecordingLanguage,
} from "./recordingLanguage";

export interface PreparedRecordingLanguages {
    languages: (RecordingLanguage | null)[];
    pending: boolean;
}
interface Dependencies {
    read(keys: string[]): Promise<(RecordingLanguage | null)[]>;
    /** Owns transport timeout and distributed rate limit; never retries indefinitely. */
    fill(track: LanguageRecording): Promise<void>;
    warn(error: unknown): void;
}

/** Optional metadata work, bounded to 64 coalesced records per process, one at a time. */
export class RecordingLanguageStore {
    private readonly queued = new Map<string, LanguageRecording>();
    private readonly pending = new Set<string>();
    private running: Promise<void> | null = null;
    constructor(private readonly dependencies: Dependencies) {}

    async prepare(
        tracks: LanguageRecording[],
    ): Promise<PreparedRecordingLanguages> {
        const keys = tracks.map(languageCacheKey);
        let languages: (RecordingLanguage | null)[];
        try {
            languages = await this.dependencies.read(keys);
            if (languages.length !== tracks.length)
                throw new Error("Invalid language cache batch");
        } catch (error) {
            this.dependencies.warn(error);
            return { languages: tracks.map(() => null), pending: false };
        }
        tracks.forEach((track, index) => {
            if (
                languages[index] ||
                this.pending.has(keys[index]) ||
                this.pending.size >= 64
            )
                return;
            this.pending.add(keys[index]);
            this.queued.set(keys[index], track);
        });
        this.start();
        return {
            languages,
            pending: languages.some((value) => value === null),
        };
    }

    /** Observe owned background work in diagnostics/shutdown without polling. */
    async drain(): Promise<void> {
        while (this.running) await this.running;
    }

    private start(): void {
        if (this.running || !this.queued.size) return;
        this.running = this.run().finally(() => {
            this.running = null;
            // A prepare() continuation may enqueue between run() finishing
            // and this finally callback. Hand that work to a new runner.
            this.start();
        });
    }

    private async run(): Promise<void> {
        while (this.queued.size) {
            const [key, track] = this.queued.entries().next().value!;
            this.queued.delete(key);
            try {
                await this.dependencies.fill(track);
            } catch (error) {
                this.dependencies.warn(error);
            } finally {
                this.pending.delete(key);
            }
        }
    }
}
