import { Client } from "pg";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const url = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres = url && databaseName ? describe : describe.skip;

describeWithPostgres("local preference acknowledgements on PostgreSQL", () => {
    let admin: Client;
    let prisma: PrismaClient;
    let preferences: typeof import("../src/services/libraryTrackPreferences");
    const userId = "local-pref-owner";
    const otherUserId = "local-pref-other";
    const trackId = "local-pref-track";
    const mutate = (
        signal: "thumbs_up" | "thumbs_down" | "clear",
        owner = userId,
    ) =>
        preferences.applyLocalTrackPreferenceSignal({
            userId: owner,
            trackId,
            signal,
            now: new Date(),
        });
    const read = async (owner = userId) => {
        const [liked, disliked] = await Promise.all([
            prisma.likedTrack.findUnique({
                where: { userId_trackId: { userId: owner, trackId } },
            }),
            prisma.dislikedEntity.findUnique({
                where: {
                    userId_entityType_entityId: {
                        userId: owner,
                        entityType: "track",
                        entityId: trackId,
                    },
                },
            }),
        ]);
        return { liked, disliked };
    };

    beforeAll(async () => {
        admin = await createScaleDatabase(url!, databaseName!);
        writeFileSync(
            join(tmpdir(), "soundspan-local-pref-pg.json"),
            JSON.stringify({ databaseName, setup: "MIGRATE_DEPLOY_PENDING" }),
        );
        await applyScaleMigrations(process.env.DATABASE_URL!, 600_000);
        writeFileSync(
            join(tmpdir(), "soundspan-local-pref-pg.json"),
            JSON.stringify({
                databaseName,
                setup: "PRISMA_MIGRATE_DEPLOY_PASS",
            }),
        );
        prisma = (
            require("../src/utils/db") as typeof import("../src/utils/db")
        ).prisma;
        preferences = require("../src/services/libraryTrackPreferences");
        await prisma.user.createMany({
            data: [userId, otherUserId].map((id) => ({
                id,
                username: id,
                isTestAccount: true,
            })),
        });
        await prisma.artist.create({
            data: {
                id: "local-pref-artist",
                name: "Fixture",
                mbid: "local-pref-artist-mbid",
            },
        });
        await prisma.album.create({
            data: {
                id: "local-pref-album",
                artistId: "local-pref-artist",
                rgMbid: "local-pref-album-mbid",
                title: "Fixture",
                primaryType: "Album",
            },
        });
        await prisma.track.create({
            data: {
                id: trackId,
                albumId: "local-pref-album",
                title: "Fixture",
                trackNo: 1,
                duration: 180,
                fileSize: 1000,
                fileModified: new Date("2026-11-16T00:00:00Z"),
            },
        });
    }, 660_000);

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
        if (admin) await dropScaleDatabase(admin, databaseName!);
    });

    test("twenty overlapping opposite pairs persist one committed signal", async () => {
        for (let pair = 0; pair < 20; pair++) {
            await mutate("clear");
            const [up, down] = await Promise.all([
                mutate("thumbs_up"),
                mutate("thumbs_down"),
            ]);
            expect(up.signal).toBe("thumbs_up");
            expect(down.signal).toBe("thumbs_down");
            const stored = await read();
            expect(
                Number(stored.liked !== null) +
                    Number(stored.disliked !== null),
            ).toBe(1);
            expect(
                preferences.formatTrackPreferenceResponse(trackId, down, {
                    queuePolicy: true,
                }).queuePolicy?.effect,
            ).toBe("exclude");
            expect(
                preferences.formatTrackPreferenceResponse(trackId, up, {
                    queuePolicy: true,
                }).queuePolicy?.effect,
            ).toBe("allow");
        }
    });

    test("concurrent owners retain independent opposite preferences", async () => {
        await Promise.all([mutate("clear"), mutate("clear", otherUserId)]);
        await Promise.all([
            mutate("thumbs_down"),
            mutate("thumbs_up", otherUserId),
        ]);
        expect(await read()).toEqual({
            liked: null,
            disliked: expect.any(Object),
        });
        expect(await read(otherUserId)).toEqual({
            liked: expect.any(Object),
            disliked: null,
        });
    });

    test("a second-statement database failure rolls back the first row", async () => {
        await mutate("thumbs_down");
        const client = new Client({
            connectionString: process.env.DATABASE_URL,
        });
        await client.connect();
        try {
            await client.query(
                `CREATE FUNCTION local_pref_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled opposite deletion failure'; END $$`,
            );
            await client.query(
                `CREATE TRIGGER local_pref_fail BEFORE DELETE ON "DislikedEntity" FOR EACH ROW EXECUTE FUNCTION local_pref_fail_delete()`,
            );
            await expect(mutate("thumbs_up")).rejects.toThrow();
            const stored = await read();
            expect(stored.liked).toBeNull();
            expect(stored.disliked).not.toBeNull();
        } finally {
            await client.query(
                `DROP TRIGGER IF EXISTS local_pref_fail ON "DislikedEntity"`,
            );
            await client.query(
                `DROP FUNCTION IF EXISTS local_pref_fail_delete()`,
            );
            await client.end();
        }
    });
});
