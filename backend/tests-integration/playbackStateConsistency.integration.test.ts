import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { Client } from "pg";

jest.mock("../src/middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: () => void) => {
        req.user = {
            id: req.header("X-Test-User") || "playback-cas-user",
            username: "cas",
        };
        next();
    },
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
    requireAdmin: (_req: any, _res: any, next: () => void) => next(),
}));
jest.mock("../src/middleware/rateLimiter", () => ({
    playbackStateLimiter: (_req: any, _res: any, next: () => void) => next(),
}));
const mockPublish = jest.fn();
jest.mock("../src/services/socialPresenceEvents", () => ({
    publishSocialPresenceUpdate: (...args: unknown[]) => mockPublish(...args),
}));
jest.mock("../src/utils/redis", () => ({
    redisClient: {
        async *scanIterator({ MATCH }: { MATCH: string }) {
            if (MATCH === "social:presence:user:*")
                yield ["social:presence:user:playback-cas-readers"];
        },
        mGet: async (keys: string[]) => keys.map(() => String(Date.now())),
    },
}));
jest.mock("../src/services/federationPeerPlaylists", () => ({
    PeerPlaylistError: class PeerPlaylistError extends Error {},
}));

import { prisma } from "../src/utils/db";
import router from "../src/routes/playbackState";
import socialRouter from "../src/routes/social";
import { getFederationPresenceExport } from "../src/services/federationPresence";
import { handleGetNowPlaying } from "../src/routes/subsonic/usersMisc";
import {
    handleGetPlayQueue,
    handleSavePlayQueue,
} from "../src/routes/subsonic/bookmarksQueue";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;
const userId = "playback-cas-user";
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const app = express().use(express.json()).use(router);
const payload = (trackId: string) => ({
    playbackType: "track",
    trackId,
    queue: [{ id: trackId }],
    currentTime: 81.125,
    isPlaying: true,
});

function save(
    device: string,
    etag: string,
    trackId = "initial",
    user = userId,
) {
    return request(app)
        .post("/")
        .set("X-Test-User", user)
        .set("X-Playback-Device-Id", device)
        .set("If-Match", etag)
        .send(payload(trackId));
}
function clear(device: string, etag: string) {
    return request(app)
        .delete("/")
        .set("X-Playback-Device-Id", device)
        .set("If-Match", etag);
}
function get(device: string) {
    return request(app).get("/").set("X-Playback-Device-Id", device);
}
async function state(deviceId: string): Promise<any> {
    return prisma.playbackState.findUnique({
        where: { userId_deviceId: { userId, deviceId } },
    });
}

describeWithPostgres("playback-state CAS against migrated PostgreSQL", () => {
    let admin: Client;
    let sql: Client;
    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        sql = new Client({ connectionString: process.env.DATABASE_URL });
        await sql.connect();
        await prisma.user.createMany({
            data: [
                { id: userId, username: "playback-cas-user" },
                { id: "playback-cas-other", username: "playback-cas-other" },
            ],
        });
    });
    beforeEach(() => {
        mockPublish.mockClear();
    });
    afterAll(async () => {
        await sql?.end();
        await prisma.$disconnect();
        if (admin) await dropScaleDatabase(admin, databaseName!);
    });

    it("supplies a DB revision default for existing raw-insert callers", async () => {
        const inserted = await sql.query(
            `INSERT INTO "PlaybackState" ("userId", "deviceId", "playbackType", "updatedAt") VALUES ($1, 'raw-default', 'track', CURRENT_TIMESTAMP) RETURNING *`,
            [userId],
        );
        expect(inserted.rows[0].revision).toMatch(uuidPattern);
        expect(inserted.rows[0].isCleared).toBe(false);
    });

    it("preserves existing queue, flags and fractional position when replaying the additive migration", async () => {
        await save("migration-replay", '"ps1.absent"');
        await sql.query("BEGIN");
        try {
            await sql.query(
                `DROP TRIGGER "PlaybackState_revision_trigger" ON "PlaybackState"; DROP FUNCTION "refreshPlaybackStateRevision"(); ALTER TABLE "PlaybackState" DROP COLUMN "revision", DROP COLUMN "isCleared";`,
            );
            await sql.query(
                readFileSync(
                    resolve(
                        __dirname,
                        "../prisma/migrations/20261014120000_playback_state_revision/migration.sql",
                    ),
                    "utf8",
                ),
            );
            const row = await sql.query(
                `SELECT * FROM "PlaybackState" WHERE "userId" = $1 AND "deviceId" = 'migration-replay'`,
                [userId],
            );
            expect(row.rows[0]).toMatchObject({
                trackId: "initial",
                currentTime: 81.125,
                isPlaying: true,
                isCleared: false,
                queue: [expect.objectContaining({ id: "initial" })],
            });
            expect(row.rows[0].revision).toMatch(uuidPattern);
        } finally {
            await sql.query("ROLLBACK");
        }
    });

    it("allows exactly one concurrent save for the same existing revision", async () => {
        const initial = await save("save-race", '"ps1.absent"');
        const results = await Promise.all([
            save("save-race", initial.headers.etag, "one"),
            save("save-race", initial.headers.etag, "two"),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
        const winner = results.find((r) => r.status === 200)!;
        expect((await get("save-race")).body.trackId).toBe(winner.body.trackId);
        expect((await get("save-race")).headers.etag).toBe(winner.headers.etag);
    });

    it("allows exactly one absent-slot create and rejects late absent saves", async () => {
        const results = await Promise.all([
            save("absent-race", '"ps1.absent"', "one"),
            save("absent-race", '"ps1.absent"', "two"),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
        expect((await save("absent-race", '"ps1.absent"', "late")).status).toBe(
            412,
        );
    });

    it("does not let a late clear delete a newer save or a late save revive a cleared queue", async () => {
        const initial = await save("late-clear", '"ps1.absent"');
        const newer = await save("late-clear", initial.headers.etag, "newer");
        expect((await clear("late-clear", initial.headers.etag)).status).toBe(
            412,
        );
        expect((await state("late-clear"))?.trackId).toBe("newer");
        const cleared = await clear("late-clear", newer.headers.etag);
        expect(cleared.status).toBe(200);
        expect(
            (await save("late-clear", newer.headers.etag, "stale")).status,
        ).toBe(412);
        expect((await get("late-clear")).body).toBeNull();
    });

    it("serializes concurrent save and clear with the same revision", async () => {
        const initial = await save("save-clear-race", '"ps1.absent"');
        const results = await Promise.all([
            save("save-clear-race", initial.headers.etag, "newer"),
            clear("save-clear-race", initial.headers.etag),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
        const winner = results.find((r) => r.status === 200)!;
        expect((await get("save-clear-race")).headers.etag).toBe(
            winner.headers.etag,
        );
    });

    it("keeps legacy fallback read-only and tombstones only the requesting slot", async () => {
        const legacy = await save("legacy", '"ps1.absent"', "legacy-track");
        const before = await state("legacy");
        const fallback = await get("legacy-reader");
        expect(fallback.body.trackId).toBe("legacy-track");
        expect(fallback.headers.etag).toBe('"ps1.absent"');
        expect(await state("legacy-reader")).toBeNull();
        expect(await state("legacy")).toEqual(before);
        const cleared = await clear("legacy-reader", fallback.headers.etag);
        expect(cleared.status).toBe(200);
        expect((await get("legacy-reader")).body).toBeNull();
        expect(await state("legacy")).toEqual(before);
        expect((await get("unrelated-reader")).body.trackId).toBe(
            "legacy-track",
        );
        expect((await clear("legacy-reader", '"ps1.absent"')).status).toBe(412);
        expect(legacy.headers.etag).toBe(`"ps1.${before!.revision}"`);
    });

    it("changes the tombstone lease on every clear and prevents ABA after restore", async () => {
        const initial = await save("aba", '"ps1.absent"');
        const cleared = await clear("aba", initial.headers.etag);
        const recleared = await clear("aba", cleared.headers.etag);
        expect(recleared.headers.etag).not.toBe(cleared.headers.etag);
        expect(await state("aba")).toMatchObject({
            isCleared: true,
            trackId: null,
            audiobookId: null,
            podcastId: null,
            queue: null,
            currentIndex: 0,
            currentTime: 0,
            isPlaying: false,
            isShuffle: false,
        });
        const restored = await save("aba", recleared.headers.etag, "restored");
        expect(restored.status).toBe(200);
        expect(restored.body.isCleared).toBe(false);
        expect((await clear("aba", initial.headers.etag)).status).toBe(412);
    });

    it("isolates revisions by both user and device", async () => {
        const first = await save("isolation-a", '"ps1.absent"');
        await save("isolation-b", '"ps1.absent"', "other-device");
        await save(
            "isolation-a",
            '"ps1.absent"',
            "other-user",
            "playback-cas-other",
        );
        expect(
            (await save("isolation-b", first.headers.etag, "wrong-slot"))
                .status,
        ).toBe(412);
        expect(
            (
                await save(
                    "isolation-a",
                    first.headers.etag,
                    "wrong-user",
                    "playback-cas-other",
                )
            ).status,
        ).toBe(412);
        expect((await state("isolation-b"))?.trackId).toBe("other-device");
    });

    it("rotates the lease for SQL updates and implicit audiobook SET NULL", async () => {
        const initial = await save("direct-sql", '"ps1.absent"');
        await sql.query(
            `UPDATE "PlaybackState" SET "currentTime" = 99 WHERE "userId" = $1 AND "deviceId" = 'direct-sql'`,
            [userId],
        );
        expect((await get("direct-sql")).headers.etag).not.toBe(
            initial.headers.etag,
        );
        await prisma.audiobook.create({
            data: {
                id: "cas-book",
                title: "Book",
                audioUrl: "cas",
                genres: [],
                tags: [],
            },
        });
        const book = await request(app)
            .post("/")
            .set("X-Playback-Device-Id", "fk-null")
            .set("If-Match", '"ps1.absent"')
            .send({
                playbackType: "audiobook",
                audiobookId: "cas-book",
                currentTime: 10,
            });
        await prisma.audiobook.delete({ where: { id: "cas-book" } });
        const nulled = await get("fk-null");
        expect(nulled.body.audiobookId).toBeNull();
        expect(nulled.headers.etag).not.toBe(book.headers.etag);
    });

    it("retries a real FK failure outside the aborted transaction with the original lease", async () => {
        const initial = await save("fk-retry", '"ps1.absent"');
        const saved = await request(app)
            .post("/")
            .set("X-Playback-Device-Id", "fk-retry")
            .set("If-Match", initial.headers.etag)
            .send({
                playbackType: "audiobook",
                audiobookId: "missing-cas-book",
                currentTime: 12.75,
            });
        expect(saved.status).toBe(200);
        expect(saved.body).toMatchObject({
            playbackType: "audiobook",
            audiobookId: null,
            currentTime: 12.75,
        });
        expect(saved.headers.etag).not.toBe(initial.headers.etag);
    });

    it("does not overwrite a competitor that wins between FK failure and retry", async () => {
        const initial = await save("fk-race", '"ps1.absent"');
        const originalTransaction = prisma.$transaction.bind(prisma);
        let raced = false;
        const spy = jest
            .spyOn(prisma, "$transaction")
            .mockImplementation((async (...args: any[]) => {
                try {
                    return await (originalTransaction as any)(...args);
                } catch (error) {
                    if (!raced) {
                        raced = true;
                        await prisma.playbackState.update({
                            where: {
                                userId_deviceId: {
                                    userId,
                                    deviceId: "fk-race",
                                },
                            },
                            data: {
                                trackId: "competitor",
                                playbackType: "track",
                            },
                        });
                    }
                    throw error;
                }
            }) as any);
        try {
            const response = await request(app)
                .post("/")
                .set("X-Playback-Device-Id", "fk-race")
                .set("If-Match", initial.headers.etag)
                .send({
                    playbackType: "audiobook",
                    audiobookId: "missing-cas-book",
                });
            expect(raced).toBe(true);
            expect(response.status).toBe(412);
            expect((await state("fk-race"))?.trackId).toBe("competitor");
            expect(mockPublish).toHaveBeenCalledTimes(1); // Initial save only.
        } finally {
            spy.mockRestore();
        }
    });

    it("preserves omitted queue fields and fractional position while bounding explicit queues", async () => {
        const initial = await save("partial", '"ps1.absent"');
        const partial = await request(app)
            .post("/")
            .set("X-Playback-Device-Id", "partial")
            .set("If-Match", initial.headers.etag)
            .send({ playbackType: "track", trackId: "initial" });
        expect(partial.body).toMatchObject({
            queue: initial.body.queue,
            currentTime: 81.125,
            isPlaying: true,
        });
        const bounded = await request(app)
            .post("/")
            .set("X-Playback-Device-Id", "partial")
            .set("If-Match", partial.headers.etag)
            .send({
                playbackType: "track",
                queue: Array.from({ length: 101 }, (_, i) => ({
                    id: `${i}`,
                    secret: "strip",
                })),
                currentIndex: 300,
            });
        expect(bounded.body.queue).toHaveLength(100);
        expect(bounded.body.currentIndex).toBe(99);
        expect(bounded.body.queue[0]).not.toHaveProperty("secret");
    });

    it("lets Subsonic save restore a cleared legacy slot and rotates its lease", async () => {
        const existing = await get("legacy");
        const cleared = await clear("legacy", existing.headers.etag);
        const req = {
            user: { id: userId, username: "cas" },
            query: { f: "json" },
        } as any;
        const res = {
            status: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            type: jest.fn().mockReturnThis(),
            send: jest.fn(),
        } as any;
        await handleGetPlayQueue(req, res);
        expect(res.send).toHaveBeenCalledTimes(1);
        const response = JSON.parse(res.send.mock.calls[0][0]);
        expect(response["subsonic-response"].status).toBe("ok");
        expect(response["subsonic-response"].playQueue).toEqual({
            position: 0,
            username: "cas",
            changed: expect.stringMatching(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
            ),
            changedBy: "soundspan",
            entry: [],
        });
        await handleSavePlayQueue(req, res);
        const restored = await get("legacy");
        expect(restored.body.isCleared).toBe(false);
        expect(restored.headers.etag).not.toBe(cleared.headers.etag);
    });

    it("selects non-cleared slots before social/federation latest and now-playing limits", async () => {
        const readerUserId = "playback-cas-readers";
        await prisma.user.create({
            data: {
                id: readerUserId,
                username: "cas-reader",
                settings: {
                    create: {
                        shareOnlinePresence: true,
                        shareListeningStatus: true,
                    },
                },
            },
        });
        await prisma.artist.create({
            data: { id: "cas-artist", mbid: "cas-artist", name: "Artist" },
        });
        await prisma.album.create({
            data: {
                id: "cas-album",
                rgMbid: "cas-album",
                artistId: "cas-artist",
                title: "Album",
                primaryType: "Album",
            },
        });
        await prisma.track.create({
            data: {
                id: "cas-reader-track",
                albumId: "cas-album",
                title: "Visible song",
                trackNo: 1,
                duration: 180,
                filePath: "cas/readers.mp3",
                fileModified: new Date(),
                fileSize: 1,
            },
        });
        const queue = [
            {
                id: "cas-reader-track",
                title: "Visible song",
                duration: 180,
                artist: { id: "cas-artist", name: "Artist" },
                album: { id: "cas-album", title: "Album" },
            },
        ];
        const common = {
            userId: readerUserId,
            playbackType: "track",
            trackId: "cas-reader-track",
            queue,
            currentIndex: 0,
            isPlaying: true,
        };
        await prisma.playbackState.create({
            data: {
                ...common,
                deviceId: "visible-slot",
                updatedAt: new Date(Date.now() - 1000),
            },
        });
        // Deliberately retain media IDs in these imported dirty tombstones, so the
        // reader predicate, rather than the safe DELETE payload, is exercised.
        await prisma.playbackState.createMany({
            data: Array.from({ length: 21 }, (_, index) => ({
                ...common,
                queue: [{ ...queue[0], title: "Cleared song" }],
                deviceId: `cleared-reader-${index}`,
                isCleared: true,
            })),
        });

        const socialApp = express().use(socialRouter);
        const online = await request(socialApp).get("/online");
        expect(online.status).toBe(200);
        const federation = await getFederationPresenceExport();

        const subsonicApp = express().use((req: any, _res, next) => {
            req.user = { id: readerUserId, username: "cas-reader" };
            next();
        });
        subsonicApp.get("/", handleGetNowPlaying);
        const nowPlaying = await request(subsonicApp).get("/?f=json");
        expect({
            social: online.body.users[0]?.listeningTrack?.title,
            federation: federation.users[0]?.track?.title,
            nowPlaying: nowPlaying.body[
                "subsonic-response"
            ].nowPlaying.entry.map((entry: any) => entry.playerId),
        }).toEqual({
            social: "Visible song",
            federation: "Visible song",
            nowPlaying: ["visible-slot"],
        });
    });
});
