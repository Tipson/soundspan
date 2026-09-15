import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

const OWNED_FILE = /^incident-(\d{13})-[a-f0-9]{16}\.jsonl$/;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

interface JournalOptions {
    directory: string;
    now?: () => number;
    maxFileBytes?: number;
    maxFiles?: number;
    maxAgeMs?: number;
    maxPending?: number;
}

/** Serialized, size/age-bounded JSONL storage; append resolves only after fsync. */
export function createPlaybackDiagnosticJournal(options: JournalOptions) {
    const directory = path.resolve(options.directory);
    const now = options.now ?? Date.now;
    const maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
    const maxFiles = options.maxFiles ?? 8;
    const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60_000;
    const maxPending = options.maxPending ?? 128;
    let pending = 0;
    let tail: Promise<void> = Promise.resolve();
    let initialized = false;
    let lastCleanupAt = -Infinity;
    let current: { filename: string; createdAt: number; bytes: number } | null =
        null;

    const listFiles = async () => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        return entries
            .flatMap((entry) => {
                const match = OWNED_FILE.exec(entry.name);
                return entry.isFile() && match
                    ? [
                          {
                              filename: path.join(directory, entry.name),
                              createdAt: Number(match[1]),
                          },
                      ]
                    : [];
            })
            .sort(
                (a, b) =>
                    a.createdAt - b.createdAt ||
                    a.filename.localeCompare(b.filename),
            );
    };

    const cleanup = async (time: number, reserveFile: boolean) => {
        const retained = [];
        for (const file of await listFiles()) {
            if (time - file.createdAt >= maxAgeMs) {
                await fs.unlink(file.filename);
                if (current?.filename === file.filename) current = null;
            } else retained.push(file);
        }
        while (retained.length > maxFiles - (reserveFile ? 1 : 0)) {
            const oldest = retained.shift()!;
            await fs.unlink(oldest.filename);
            if (current?.filename === oldest.filename) current = null;
        }
        lastCleanupAt = time;
    };

    const write = async (line: string, bytes: number) => {
        try {
            if (!initialized) {
                await fs.mkdir(directory, { recursive: true, mode: 0o700 });
                const directoryInfo = await fs.lstat(directory);
                if (
                    !directoryInfo.isDirectory() ||
                    directoryInfo.isSymbolicLink()
                ) {
                    throw new Error("Invalid diagnostic journal directory");
                }
                initialized = true;
            }
            const time = now();
            if (time - lastCleanupAt >= CLEANUP_INTERVAL_MS)
                await cleanup(time, false);
            const rotate =
                !current ||
                current.bytes + bytes > maxFileBytes ||
                time - current.createdAt >= maxAgeMs ||
                Math.floor(time / 86_400_000) !==
                    Math.floor(current.createdAt / 86_400_000);
            if (rotate) {
                await cleanup(time, true);
                current = {
                    filename: path.join(
                        directory,
                        `incident-${String(Math.trunc(time)).padStart(13, "0")}-${randomBytes(8).toString("hex")}.jsonl`,
                    ),
                    createdAt: time,
                    bytes: 0,
                };
            }
            const target = current!;
            const flags =
                constants.O_WRONLY |
                constants.O_APPEND |
                constants.O_CREAT |
                (constants.O_NOFOLLOW ?? 0) |
                (rotate ? constants.O_EXCL : 0);
            const handle = await fs.open(target.filename, flags, 0o600);
            try {
                await handle.writeFile(line, "utf8");
                await handle.sync();
                target.bytes += bytes;
            } finally {
                await handle.close();
            }
        } catch (error) {
            // A failed append can leave an incomplete tail. A retry gets a new
            // file so subsequent valid records cannot join that partial line.
            current = null;
            throw error;
        }
    };

    return {
        /** Queue one sanitized record, rejecting overload before retaining its payload. */
        append(record: Record<string, unknown>): Promise<void> {
            if (pending >= maxPending)
                return Promise.reject(new Error("Diagnostic journal busy"));
            const line = JSON.stringify(record) + "\n";
            const bytes = Buffer.byteLength(line);
            if (bytes > Math.min(8192, maxFileBytes))
                return Promise.reject(
                    new Error("Diagnostic journal record too large"),
                );
            pending++;
            const task = tail.then(() => write(line, bytes));
            tail = task.then(
                () => undefined,
                () => undefined,
            );
            return task.finally(() => {
                pending--;
            });
        },
    };
}

/** Docker mounts ./logs at /app/logs; this private subdirectory survives API replacement. */
export const playbackDiagnosticJournal = createPlaybackDiagnosticJournal({
    directory: path.join(process.cwd(), "logs", "playback-diagnostics"),
});
