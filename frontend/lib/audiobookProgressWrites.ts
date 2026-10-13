import {
    getAuthRuntimeLease,
    isCurrentAuthRuntime,
} from "./auth-runtime-generation";

/** A captured authority for one account, book, and progress revision. */
export interface AudiobookProgressWrite {
    /** Whether this intent still owns metadata updates. */
    isCurrent(): boolean;
    /** Serialize an API write, skipping obsolete work before credentials are read. */
    run(write: () => Promise<unknown>): Promise<boolean>;
}

interface BookWrites {
    revision: number;
    terminal: boolean;
    tail: Promise<void>;
}
let generation = -1;
const books = new Map<string, BookWrites>();
function bookWrites(id: string): BookWrites {
    const current = getAuthRuntimeLease().generation;
    if (generation !== current) {
        books.clear();
        generation = current;
    }
    let entry = books.get(id);
    if (!entry) {
        entry = { revision: 0, terminal: false, tail: Promise.resolve() };
        books.set(id, entry);
    }
    return entry;
}

/** A new playing session may replace a previous manual finish or reset. */
export function resumeAudiobookProgressWrites(id: string): void {
    const entry = bookWrites(id);
    entry.revision += 1;
    entry.terminal = false;
}

/** Capture metadata authority before pause can schedule an automatic save. */
export function captureAudiobookProgressWrite(
    id: string,
    terminal = false,
): AudiobookProgressWrite {
    const auth = getAuthRuntimeLease();
    const entry = bookWrites(id);
    if (terminal) {
        entry.revision += 1;
        entry.terminal = true;
    }
    const revision = entry.revision;
    const allowed = terminal || !entry.terminal;
    const isCurrent = () =>
        allowed &&
        !auth.signal.aborted &&
        isCurrentAuthRuntime(auth.generation) &&
        entry.revision === revision;
    return {
        isCurrent,
        async run(write: () => Promise<unknown>): Promise<boolean> {
            const operation = entry.tail.then(async () => {
                // Check before invoking the API: it reads the current token.
                if (!isCurrent()) return false;
                try {
                    await write();
                    return isCurrent();
                } catch (error) {
                    if (terminal && isCurrent()) entry.terminal = false;
                    throw error;
                }
            });
            // A failed write must not poison a later manual retry.
            entry.tail = operation.then(
                () => {},
                () => {},
            );
            return operation;
        },
    };
}
