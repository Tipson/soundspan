import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlaybackDiagnosticJournal } from "../playbackDiagnosticJournal";

describe("persistent playback diagnostic journal", () => {
    let directory: string;
    beforeEach(async () => {
        directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "soundspan-diagnostic-test-"),
        );
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        const resolved = path.resolve(directory);
        if (
            !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
            !path.basename(resolved).startsWith("soundspan-diagnostic-test-")
        ) {
            throw new Error("Unexpected diagnostic test cleanup target");
        }
        await fs.rm(resolved, { recursive: true, force: true });
    });
    const readRecords = async (folder: string) => {
        const names = (await fs.readdir(folder)).filter((name) =>
            name.endsWith(".jsonl"),
        );
        const content = await Promise.all(
            names.map((name) => fs.readFile(path.join(folder, name), "utf8")),
        );
        return content.flatMap((text) =>
            text
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line)),
        );
    };

    it("keeps acknowledged records when a new API writer opens the same persistent directory", async () => {
        const first = createPlaybackDiagnosticJournal({ directory });
        await first.append({ eventId: "before-restart", receivedAtMs: 1 });
        const next = createPlaybackDiagnosticJournal({ directory });
        await next.append({ eventId: "after-restart", receivedAtMs: 2 });
        expect(
            (await readRecords(directory))
                .map((record) => record.eventId)
                .sort(),
        ).toEqual(["after-restart", "before-restart"]);
    });

    it("serializes concurrent JSON lines without losing records", async () => {
        const journal = createPlaybackDiagnosticJournal({ directory });
        await Promise.all(
            Array.from({ length: 32 }, (_, index) =>
                journal.append({ eventId: `event-${index}` }),
            ),
        );
        const records = await readRecords(directory);
        expect(records).toHaveLength(32);
        expect(new Set(records.map((record) => record.eventId)).size).toBe(32);
    });

    it("does not acknowledge or start the next write until the first fsync completes", async () => {
        const realOpen = fs.open.bind(fs);
        let release!: () => void;
        let entered!: () => void;
        const enteredSync = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const sync = jest.fn();
        jest.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await realOpen(...args);
            const realSync = handle.sync.bind(handle);
            jest.spyOn(handle, "sync").mockImplementation(async () => {
                sync();
                if (sync.mock.calls.length === 1) {
                    entered();
                    await gate;
                }
                await realSync();
            });
            return handle;
        });
        const journal = createPlaybackDiagnosticJournal({ directory });
        let acknowledged = false;
        const first = journal.append({ eventId: "first" }).then(() => {
            acknowledged = true;
        });
        const second = journal.append({ eventId: "second" });
        await enteredSync;
        expect(acknowledged).toBe(false);
        expect(sync).toHaveBeenCalledTimes(1);
        expect(fs.open).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([first, second]);
        expect(acknowledged).toBe(true);
        expect(sync).toHaveBeenCalledTimes(2);
    });

    it("rejects an oversized UTF-8 record before touching storage", async () => {
        const mkdir = jest.spyOn(fs, "mkdir");
        const journal = createPlaybackDiagnosticJournal({ directory });
        await expect(
            journal.append({ data: "音".repeat(3000) }),
        ).rejects.toThrow("record too large");
        expect(mkdir).not.toHaveBeenCalled();
        expect(await fs.readdir(directory)).toEqual([]);
    });

    it("preserves unrelated owned-looking directories and rejects a symlink journal directory", async () => {
        const ownedLookingDirectory = path.join(
            directory,
            "incident-0000000000000-abcdef0123456789.jsonl",
        );
        await fs.mkdir(ownedLookingDirectory);
        await fs.writeFile(
            path.join(ownedLookingDirectory, "keep.txt"),
            "keep",
        );
        await createPlaybackDiagnosticJournal({ directory }).append({
            eventId: "safe",
        });
        expect(
            await fs.readFile(
                path.join(ownedLookingDirectory, "keep.txt"),
                "utf8",
            ),
        ).toBe("keep");
        const target = path.join(directory, "target");
        const linked = path.join(directory, "linked");
        await fs.mkdir(target);
        await fs.symlink(
            target,
            linked,
            process.platform === "win32" ? "junction" : "dir",
        );
        await expect(
            createPlaybackDiagnosticJournal({ directory: linked }).append({
                eventId: "unsafe",
            }),
        ).rejects.toThrow("Invalid diagnostic journal directory");
        expect(await fs.readdir(target)).toEqual([]);
    });

    it("bounds rotation bytes and file count while preserving unrelated files", async () => {
        await fs.writeFile(path.join(directory, "operator-note.txt"), "keep");
        const journal = createPlaybackDiagnosticJournal({
            directory,
            maxFileBytes: 90,
            maxFiles: 3,
        });
        for (let index = 0; index < 20; index++)
            await journal.append({
                eventId: `event-${index}`,
                value: "x".repeat(25),
            });
        const names = (await fs.readdir(directory)).filter((name) =>
            name.endsWith(".jsonl"),
        );
        expect(names.length).toBeLessThanOrEqual(3);
        for (const name of names)
            expect(
                (await fs.stat(path.join(directory, name))).size,
            ).toBeLessThanOrEqual(90);
        expect(
            await fs.readFile(
                path.join(directory, "operator-note.txt"),
                "utf8",
            ),
        ).toBe("keep");
        expect(
            (await readRecords(directory)).some(
                (record) => record.eventId === "event-19",
            ),
        ).toBe(true);
    });

    it("prunes by server ingestion age rather than a client-supplied timestamp", async () => {
        let now = 100_000;
        const journal = createPlaybackDiagnosticJournal({
            directory,
            now: () => now,
            maxAgeMs: 60_000,
        });
        await journal.append({
            eventId: "old",
            observedAtMs: Number.MAX_SAFE_INTEGER,
        });
        now += 360_000;
        await journal.append({ eventId: "new", observedAtMs: 0 });
        expect(
            (await readRecords(directory)).map((record) => record.eventId),
        ).toEqual(["new"]);
    });

    it("bounds queued writes and can continue after the in-flight write finishes", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        jest.spyOn(fs, "mkdir").mockImplementationOnce(async () => {
            await gate;
            return undefined;
        });
        const journal = createPlaybackDiagnosticJournal({
            directory,
            maxPending: 2,
        });
        const first = journal.append({ eventId: "first" });
        const second = journal.append({ eventId: "second" });
        await expect(journal.append({ eventId: "overflow" })).rejects.toThrow(
            "Diagnostic journal busy",
        );
        release();
        await Promise.all([first, second]);
        await journal.append({ eventId: "later" });
        expect(
            (await readRecords(directory)).map((record) => record.eventId),
        ).toEqual(["first", "second", "later"]);
    });

    it("rejects failed IO and accepts a later retry without reporting a false success", async () => {
        const journal = createPlaybackDiagnosticJournal({ directory });
        jest.spyOn(fs, "open").mockRejectedValueOnce(
            Object.assign(new Error("disk unavailable"), { code: "EIO" }),
        );
        await expect(journal.append({ eventId: "retry" })).rejects.toThrow(
            "disk unavailable",
        );
        await journal.append({ eventId: "retry" });
        expect(await readRecords(directory)).toEqual([{ eventId: "retry" }]);
    });
});
