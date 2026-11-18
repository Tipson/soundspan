import { Prisma } from "@prisma/client";

const mockMatchDraftTracks = jest.fn();
const mockDeleteCache = jest.fn();
let mockRows: Record<string, any[]>;
let mockTail = Promise.resolve();
let mockFailNotification = false;
let mockInsideTransaction = false;
let mockId = 0;
const names = [
    "importJob",
    "playlist",
    "playlistItem",
    "playlistPendingTrack",
    "track",
    "trackYtMusic",
    "likedTrack",
    "likedRemoteTrack",
    "dislikedEntity",
    "remotePreferenceIntent",
    "savedMusicEntity",
    "notification",
];
function matches(row: any, where: any = {}): boolean {
    return Object.entries(where).every(([key, value]: [string, any]) => {
        if (key === "OR") return value.some((part: any) => matches(row, part));
        if (key === "AND")
            return value.every((part: any) => matches(row, part));
        if (key === "NOT") return !matches(row, value);
        if (value && typeof value === "object" && !(value instanceof Date)) {
            if ("in" in value) return value.in.includes(row[key]);
            if ("not" in value) return row[key] !== value.not;
            if ("path" in value)
                return (
                    value.path.reduce(
                        (v: any, part: string) => v?.[part],
                        row[key],
                    ) === value.equals
                );
            if (!(key in row)) return matches(row, value);
            return matches(row[key], value);
        }
        return row[key] === value;
    });
}
function apply(row: any, data: any): any {
    for (const [key, value] of Object.entries(data)) {
        row[key] =
            value === Prisma.DbNull || value === Prisma.JsonNull
                ? null
                : value && typeof value === "object" && "increment" in value
                  ? (row[key] ?? 0) + (value as any).increment
                  : structuredClone(value);
    }
    row.updatedAt = new Date();
    return row;
}
function modelApi(getRows: () => Record<string, any[]>) {
    return Object.fromEntries(
        names.map((name) => [
            name,
            {
                findUnique: jest.fn(async ({ where }: any) =>
                    structuredClone(
                        getRows()[name].find((row) => matches(row, where)) ??
                            null,
                    ),
                ),
                findFirst: jest.fn(async ({ where }: any) =>
                    structuredClone(
                        getRows()[name].find((row) => matches(row, where)) ??
                            null,
                    ),
                ),
                findMany: jest.fn(async ({ where, take }: any = {}) =>
                    structuredClone(
                        getRows()
                            [name].filter((row) => matches(row, where))
                            .slice(0, take),
                    ),
                ),
                create: jest.fn(async ({ data }: any) => {
                    if (name === "notification" && mockFailNotification)
                        throw new Error("fixture_commit_failure");
                    const row = apply(
                        {
                            id: `${name}-${++mockId}`,
                            createdAt: new Date(),
                            updatedAt: new Date(),
                            status: "pending",
                            draftRevision: 0,
                            draftData: null,
                            confirmedSnapshot: null,
                            draftResult: null,
                            resolvedTracks: null,
                            createdPlaylistId: null,
                            resolutionAttempt: 0,
                            resolutionStartedAt: null,
                            resolutionProcessed: 0,
                        },
                        data,
                    );
                    getRows()[name].push(row);
                    return structuredClone(row);
                }),
                updateMany: jest.fn(async ({ where, data }: any) => {
                    const rows = getRows()[name].filter((row) =>
                        matches(row, where),
                    );
                    rows.forEach((row) => apply(row, data));
                    return { count: rows.length };
                }),
                createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
                    let count = 0;
                    for (const item of data) {
                        if (
                            skipDuplicates &&
                            getRows()[name].some((row) =>
                                Object.keys(item)
                                    .filter((key) => key !== "likedAt")
                                    .every((key) => row[key] === item[key]),
                            )
                        )
                            continue;
                        getRows()[name].push({
                            id: `${name}-${++mockId}`,
                            ...structuredClone(item),
                        });
                        count++;
                    }
                    return { count };
                }),
                upsert: jest.fn(async ({ where, create, update }: any) => {
                    if (name === "notification" && mockFailNotification)
                        throw new Error("fixture_commit_failure");
                    const current = getRows()[name].find((row) =>
                        matches(row, where),
                    );
                    if (current) return structuredClone(apply(current, update));
                    const row = {
                        id: `${name}-${++mockId}`,
                        ...structuredClone(create),
                    };
                    getRows()[name].push(row);
                    return structuredClone(row);
                }),
            },
        ]),
    );
}
const mockPrisma: any = modelApi(() => mockRows);
mockPrisma.$transaction = jest.fn((body: (tx: any) => Promise<any>) => {
    const next = mockTail.then(async () => {
        const working = structuredClone(mockRows);
        mockInsideTransaction = true;
        try {
            const result = await body(modelApi(() => working));
            mockRows = working;
            return result;
        } finally {
            mockInsideTransaction = false;
        }
    });
    mockTail = next.then(
        () => undefined,
        () => undefined,
    );
    return next;
});
jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/redis", () => ({
    redisClient: { del: mockDeleteCache },
}));
jest.mock("../../utils/logger", () => {
    const logger = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});
jest.mock("../playlistImportService", () => ({
    playlistImportService: { matchDraftTracks: mockMatchDraftTracks },
}));

import { importDraftService } from "../importDraftService";
import { importJobStore } from "../importJobStore";

describe("persisted owner import draft protocol", () => {
    beforeEach(() => {
        mockRows = Object.fromEntries(names.map((name) => [name, []]));
        mockTail = Promise.resolve();
        mockFailNotification = false;
        mockInsideTransaction = false;
        mockRows.track.push({
            id: "local-1",
            title: "Song",
            artist: "Artist",
            origin: "LOCAL",
            removedAt: null,
            filePath: "/music/song.flac",
            album: { location: "LIBRARY" },
        });
        mockMatchDraftTracks
            .mockReset()
            .mockImplementation(async (entries: any[]) =>
                entries.map((entry) =>
                    entry.artist
                        ? {
                              source: "local",
                              trackId: "local-1",
                              confidence: 95,
                          }
                        : { source: "unresolved", confidence: 0 },
                ),
            );
        mockDeleteCache.mockReset().mockImplementation(async () => {
            expect(mockInsideTransaction).toBe(false);
            return 1;
        });
    });
    async function preview(
        content = "Artist - Song\nArtist - Song\nUnresolved",
    ) {
        let job = await importDraftService.create("owner-a", {
            format: "text",
            content,
            name: "Imported",
        });
        await importDraftService.requestPreview("owner-a", job.id, 1);
        await importDraftService.runJob(job.id);
        job = await importDraftService.get("owner-a", job.id);
        return job;
    }
    function confirmation(job: any, categories = ["playlists"]) {
        const p = job.draftData.preview;
        return {
            revision: job.draftRevision,
            previewRevision: p.previewRevision,
            mappingDigest: p.mappingDigest,
            categories,
        };
    }

    it("stores normalized input without effects and previews before explicit category confirmation", async () => {
        const job = await preview();
        expect(job.status).toBe("awaiting_confirmation");
        expect(mockRows.playlist).toHaveLength(0);
        expect(mockRows.likedTrack).toHaveLength(0);
        expect(job.draftData.preview!.rows).toHaveLength(3);
        expect(
            job.draftData.normalized.entries.map((e: any) => e.position),
        ).toEqual([0, 1, 2]);
    });
    it("requires explicit category selection; default preview never adds likes", async () => {
        const job = await preview();
        await expect(
            importDraftService.confirm("owner-a", job.id, {
                ...confirmation(job),
                categories: [],
            }),
        ).rejects.toMatchObject({ code: "import_selection_invalid" });
        expect(mockRows.likedTrack).toHaveLength(0);
    });
    it("preserves ordered duplicate items and unresolved original positions", async () => {
        const job = await preview();
        await importDraftService.confirm("owner-a", job.id, confirmation(job));
        expect(mockRows.playlist).toHaveLength(0);
        await importDraftService.runJob(job.id);
        expect(
            mockRows.playlistItem.map((row) => [row.trackId, row.sort]),
        ).toEqual([
            ["local-1", 0],
            ["local-1", 1],
        ]);
        expect(
            mockRows.playlistPendingTrack.map((row) => [
                row.spotifyTitle,
                row.sort,
            ]),
        ).toEqual([["Unresolved", 2]]);
        expect(mockRows.likedTrack).toHaveLength(0);
    });
    it("rejects a draft edited after preview and requires a fresh preview revision", async () => {
        const job = await preview();
        await importDraftService.update("owner-a", job.id, 1, {
            format: "text",
            content: "New - Song",
        });
        await expect(
            importDraftService.confirm("owner-a", job.id, confirmation(job)),
        ).rejects.toMatchObject({ code: "import_draft_revision_conflict" });
        expect(mockRows.playlist).toHaveLength(0);
    });
    it("does not reuse a previous preview token after repreviewing unchanged source", async () => {
        const job = await preview();
        await importDraftService.requestPreview("owner-a", job.id, 1);
        await importDraftService.runJob(job.id);
        await expect(
            importDraftService.confirm("owner-a", job.id, confirmation(job)),
        ).rejects.toMatchObject({ code: "import_draft_revision_conflict" });
    });
    it("binds owner identity at every read and confirmation", async () => {
        const job = await preview();
        await expect(
            importDraftService.get("owner-b", job.id),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
            importDraftService.confirm("owner-b", job.id, confirmation(job)),
        ).rejects.toMatchObject({ status: 403 });
        expect(mockRows.playlist).toHaveLength(0);
    });
    it("two confirms and two workers commit exactly one immutable effect set", async () => {
        const job = await preview("Artist - Song");
        await Promise.all([
            importDraftService.confirm("owner-a", job.id, confirmation(job)),
            importDraftService.confirm("owner-a", job.id, confirmation(job)),
        ]);
        await Promise.all([
            importDraftService.runJob(job.id),
            importDraftService.runJob(job.id),
        ]);
        const first = await importDraftService.get("owner-a", job.id);
        await importDraftService.confirm("owner-a", job.id, confirmation(job));
        await importDraftService.runJob(job.id);
        const retry = await importDraftService.get("owner-a", job.id);
        expect(retry.draftResult).toEqual(first.draftResult);
        expect(mockRows.playlist).toHaveLength(1);
        expect(mockRows.playlistItem).toHaveLength(1);
        expect(mockRows.notification).toHaveLength(1);
    });
    it("a crash before atomic completion rolls back every effect and recovers the same job", async () => {
        const job = await preview("Artist - Song");
        await importDraftService.confirm("owner-a", job.id, confirmation(job));
        mockFailNotification = true;
        await expect(
            importDraftService.runJob(job.id, {
                retryFailures: true,
                finalAttempt: false,
            }),
        ).rejects.toThrow();
        expect(mockRows.playlist).toHaveLength(0);
        expect(mockRows.playlistItem).toHaveLength(0);
        mockFailNotification = false;
        await importDraftService.runJob(job.id);
        expect(mockRows.playlist).toHaveLength(1);
    });
    it("cancel before execution prevents all selected effects", async () => {
        const job = await preview();
        await importDraftService.confirm("owner-a", job.id, confirmation(job));
        await importJobStore.requestCancellation(job.id, "owner-a");
        await importDraftService.runJob(job.id);
        expect((await importDraftService.get("owner-a", job.id)).status).toBe(
            "cancelled",
        );
        expect(mockRows.playlist).toHaveLength(0);
    });
    it("separates opt-in saved entities/likes and retains unsupported exact Spotify negatives", async () => {
        const file = {
            tracks: [
                { artist: "Artist", track: "Song", uri: "spotify:track:one" },
            ],
            albums: [
                { artist: "Artist", album: "Album", uri: "spotify:album:two" },
            ],
            artists: [{ name: "Artist", uri: "spotify:artist:three" }],
            bannedTracks: [
                { artist: "Artist", track: "Song", uri: "spotify:track:four" },
            ],
        };
        let job = await importDraftService.create("owner-a", {
            format: "spotify-json",
            content: JSON.stringify(file),
        });
        await importDraftService.requestPreview("owner-a", job.id, 1);
        await importDraftService.runJob(job.id);
        job = await importDraftService.get("owner-a", job.id);
        await importDraftService.confirm(
            "owner-a",
            job.id,
            confirmation(job, ["likes", "albums", "artists", "dislikes"]),
        );
        await importDraftService.runJob(job.id);
        expect(mockRows.likedTrack).toHaveLength(1);
        expect(
            mockRows.savedMusicEntity.map((row) => [
                row.source,
                row.entityType,
                row.entityId,
            ]),
        ).toEqual([
            ["spotify", "album", "two"],
            ["spotify", "artist", "three"],
        ]);
        expect(mockRows.dislikedEntity).toHaveLength(0);
        expect(
            (await importDraftService.get("owner-a", job.id)).draftResult!
                .unresolved,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    reason: "exact_negative_unavailable",
                }),
            ]),
        );
    });
    it("applies only an explicit exact negative, never the fuzzy matched local ID", async () => {
        let job = await importDraftService.create("owner-a", {
            format: "text",
            textCategory: "dislikes",
            content: "yt:video_123\tArtist\tSong",
        });
        await importDraftService.requestPreview("owner-a", job.id, 1);
        await importDraftService.runJob(job.id);
        job = await importDraftService.get("owner-a", job.id);
        await importDraftService.confirm(
            "owner-a",
            job.id,
            confirmation(job, ["dislikes"]),
        );
        await importDraftService.runJob(job.id);
        expect(mockRows.dislikedEntity.map((row) => row.entityId)).toEqual([
            "yt:video_123",
        ]);
        expect(mockRows.likedTrack).toHaveLength(0);
    });
    it("durably retries only postcommit owner cache invalidation after Redis failure", async () => {
        const job = await preview("Artist - Song");
        await importDraftService.confirm("owner-a", job.id, confirmation(job));
        mockDeleteCache.mockRejectedValueOnce(new Error("redis_down"));
        await importDraftService.runJob(job.id);
        expect(
            (await importDraftService.get("owner-a", job.id)).draftResult!
                .invalidationPending,
        ).toBe(true);
        await importDraftService.recoverPostCommit();
        expect(
            (await importDraftService.get("owner-a", job.id)).draftResult!
                .invalidationPending,
        ).toBe(false);
        expect(mockRows.playlist).toHaveLength(1);
        expect(mockDeleteCache).toHaveBeenCalledWith("mixes:owner-a");
    });
    it("cannot publish a late preview for an edited draft", async () => {
        let job = await importDraftService.create("owner-a", {
            format: "text",
            content: "Artist - Song",
        });
        await importDraftService.requestPreview("owner-a", job.id, 1);
        let finish!: (value: any) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => (entered = resolve));
        mockMatchDraftTracks.mockImplementationOnce(() => {
            entered();
            return new Promise((resolve) => (finish = resolve));
        });
        const pending = importDraftService.runJob(job.id);
        await started;
        await importDraftService.update("owner-a", job.id, 1, {
            format: "text",
            content: "Other - Song",
        });
        finish([{ source: "local", trackId: "local-1", confidence: 95 }]);
        await pending;
        job = await importDraftService.get("owner-a", job.id);
        expect(job.draftRevision).toBe(2);
        expect(job.draftData.preview).toBeNull();
        expect(job.status).toBe("draft");
    });
    it("ignores stale queue delivery and failure after a draft revision changes", async () => {
        const job = await preview("Artist - Song");
        const old = {
            version: 1 as const,
            revision: 1,
            attempt: job.resolutionAttempt,
        };
        await importDraftService.update("owner-a", job.id, 1, {
            format: "text",
            content: "New - Song",
        });
        const next = await importDraftService.requestPreview(
            "owner-a",
            job.id,
            2,
        );
        mockMatchDraftTracks.mockClear();
        await importDraftService.runJob(job.id, { draftFence: old });
        await importDraftService.finalizeQueueFailure(job.id, old);
        expect(mockMatchDraftTracks).not.toHaveBeenCalled();
        expect((await importDraftService.get("owner-a", job.id)).status).toBe(
            "previewing",
        );
        await importDraftService.runJob(job.id, {
            draftFence: {
                version: 1,
                revision: 2,
                attempt: next.resolutionAttempt,
            },
        });
        expect((await importDraftService.get("owner-a", job.id)).status).toBe(
            "awaiting_confirmation",
        );
    });
});
