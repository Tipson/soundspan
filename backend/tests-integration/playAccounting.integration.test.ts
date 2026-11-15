import express from "express";
import request from "supertest";
import type { Client } from "pg";
import {
    createPlayRequestTrace,
    type PlayStageSample,
} from "../src/services/playRequestTrace";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const suite = integrationUrl && databaseName ? describe : describe.skip;
const mockPlayCreationPolicy = {
    newCreationsEnabled: false,
    replaySupported: false,
};
jest.mock("../src/config", () => {
    const actual = jest.requireActual("../src/config");
    return {
        ...actual,
        config: { ...actual.config, playCreation: mockPlayCreationPolicy },
    };
});

suite("owner-scoped Play creation contract on isolated PostgreSQL", () => {
    let admin: Client;
    let prisma: typeof import("../src/utils/db").prisma;
    let auth: typeof import("../src/middleware/auth");
    let app: express.Express;
    let owner: {
        id: string;
        username: string;
        role: string;
        tokenVersion: number;
    };
    const samples: PlayStageSample[] = [];

    const recording = {
        provider: "vk" as const,
        id: "-1_2",
        title: "Private fixture title",
        artists: ["Private fixture artist"],
        duration: 200,
        contentVersion: "unknown" as const,
        preview: false as const,
    };
    const key = (nonce = "A".repeat(32), issuedAt = Date.now(), epoch = 0) =>
        `p1.${epoch.toString(36)}.${issuedAt.toString(36)}.${nonce}`;

    function post(clientPlaybackId: string, extra = {}, user = owner) {
        return request(app)
            .post("/api/plays/idempotent")
            .set("Authorization", `Bearer ${auth.generateToken(user)}`)
            .send({
                clientPlaybackId,
                musicSourceRecording: recording,
                ...extra,
            });
    }

    beforeAll(async () => {
        admin = await createScaleDatabase(integrationUrl!, databaseName!);
        await applyScaleMigrations(process.env.DATABASE_URL!, 180_000);
        prisma = (
            require("../src/utils/db") as typeof import("../src/utils/db")
        ).prisma;
        auth = require("../src/middleware/auth") as typeof auth;
        const plays = (
            require("../src/routes/plays") as typeof import("../src/routes/plays")
        ).default;
        const system = (
            require("../src/routes/system") as typeof import("../src/routes/system")
        ).default;
        app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            createPlayRequestTrace(req, res, {
                record: (sample) => samples.push(sample),
            });
            next();
        });
        app.use("/api/plays", plays);
        app.use("/api/system", system);
    }, 210_000);

    beforeEach(async () => {
        mockPlayCreationPolicy.newCreationsEnabled = true;
        mockPlayCreationPolicy.replaySupported = true;
        samples.length = 0;
        await prisma.user.deleteMany({
            where: { id: { startsWith: "dev08-core-" } },
        });
        owner = await prisma.user.create({
            data: {
                id: "dev08-core-owner",
                username: "dev08-core-owner",
                isTestAccount: true,
            },
        });
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
        if (admin) await dropScaleDatabase(admin, databaseName!);
    });

    test("disabled capability never admits a client or creates a Play", async () => {
        mockPlayCreationPolicy.newCreationsEnabled = false;
        mockPlayCreationPolicy.replaySupported = false;
        const features = await request(app)
            .get("/api/system/features")
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`);
        expect(features.status).toBe(200);
        expect(features.headers["cache-control"]).toBe("private, no-store");
        expect(features.body.playCreation).toMatchObject({
            version: 1,
            newCreationsEnabled: false,
            replaySupported: false,
        });
        expect((await post(key())).status).toBe(503);
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            0,
        );
    });

    test("a frozen owner/key/payload returns one Play and a versioned replay acknowledgement", async () => {
        const clientPlaybackId = key();
        const first = await post(clientPlaybackId);
        expect(first.status).toBe(200);
        expect(first.headers["x-soundspan-play-write"]).toBe("committed");
        samples.length = 0;
        const replay = await post(clientPlaybackId);
        expect(replay.status).toBe(200);
        expect(replay.body.id).toBe(first.body.id);
        expect(replay.headers["x-soundspan-play-write"]).toBe("not_started");
        expect(
            samples.some((sample) => sample.stage === "db_acquire_write"),
        ).toBe(false);
        expect(first.body.playCreation).toMatchObject({
            version: 1,
            clientPlaybackId,
            disposition: "created",
        });
        expect(replay.body.playCreation).toMatchObject({
            version: 1,
            clientPlaybackId,
            disposition: "replayed",
        });
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            1,
        );
    });

    test("parallel duplicate requests commit one Play", async () => {
        const clientPlaybackId = key();
        const [one, two] = await Promise.all([
            post(clientPlaybackId),
            post(clientPlaybackId),
        ]);
        expect(one.status).toBe(200);
        expect(two.status).toBe(200);
        expect(one.body.id).toBe(two.body.id);
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            1,
        );
    });

    test("payload conflict never changes the existing Play", async () => {
        const clientPlaybackId = key();
        const first = await post(clientPlaybackId);
        expect(first.status).toBe(200);
        const conflict = await post(clientPlaybackId, {
            musicSourceRecording: { ...recording, title: "Different payload" },
        });
        expect(conflict.status).toBe(409);
        expect(conflict.body.code).toBe("play_key_payload_conflict");
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            1,
        );
    });

    test("expired and prior-epoch keys never create a Play", async () => {
        expect(
            (await post(key("B".repeat(32), Date.now() - 25 * 3600_000)))
                .status,
        ).toBe(410);
        expect((await post(key("C".repeat(32), Date.now(), 1))).status).toBe(
            410,
        );
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            0,
        );
    });

    test("legacy POST does not silently accept an idempotency key", async () => {
        const response = await request(app)
            .post("/api/plays")
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`)
            .send({ clientPlaybackId: key(), musicSourceRecording: recording });
        expect(response.status).toBe(400);
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            0,
        );
    });

    async function generation(suffix: string) {
        return prisma.recommendationGeneration.create({
            data: {
                userId: owner.id,
                sessionId: suffix,
                surface: "wave",
                direction: "for-you",
                algorithm: "dev08-fixture",
                degradedSources: [],
                latencyMs: 0,
                exposures: {
                    create: {
                        userId: owner.id,
                        canonicalKey: "vk:-1_2",
                        artistKey: "fixture",
                        provider: "vk",
                        providerTrackId: "-1_2",
                        source: "VK",
                        position: 0,
                    },
                },
            },
            include: { exposures: true },
        });
    }

    function engagement(
        id: string,
        listenedSeconds: number,
        outcome = "meaningful",
    ) {
        return request(app)
            .patch(`/api/plays/${id}/engagement`)
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`)
            .send({
                listenedSeconds,
                completionRatio: listenedSeconds / 200,
                outcome,
            });
    }

    test("creation freezes a target and PATCH cannot drift to a newer generation", async () => {
        const firstGeneration = await generation("one");
        const created = await post(key(), {
            recommendationGenerationId: firstGeneration.id,
        });
        expect(created.status).toBe(200);
        const newer = await generation("two");
        expect((await engagement(created.body.id, 100)).status).toBe(200);
        const rows = await prisma.recommendationExposure.findMany({
            where: { userId: owner.id },
        });
        expect(
            rows.find((row) => row.id === firstGeneration.exposures[0].id)
                ?.listenedSeconds,
        ).toBe(100);
        expect(
            rows.find((row) => row.id === newer.exposures[0].id)?.playedAt,
        ).toBeNull();
        expect(
            (
                await prisma.play.findUniqueOrThrow({
                    where: { id: created.body.id },
                })
            ).localAttributionState,
        ).toBe("APPLIED");
    });

    test("NO_TARGET is final for the Play, including replay and PATCH", async () => {
        const clientPlaybackId = key();
        const created = await post(clientPlaybackId);
        const later = await generation("later");
        await prisma.recommendationExposure.update({
            where: { id: later.exposures[0].id },
            data: { viewedAt: new Date(Date.now() - 1000) },
        });
        expect((await post(clientPlaybackId)).status).toBe(200);
        expect((await engagement(created.body.id, 100)).status).toBe(200);
        expect(
            (
                await prisma.recommendationExposure.findUniqueOrThrow({
                    where: { id: later.exposures[0].id },
                })
            ).playedAt,
        ).toBeNull();
        expect(
            (
                await prisma.play.findUniqueOrThrow({
                    where: { id: created.body.id },
                })
            ).localAttributionState,
        ).toBe("NO_TARGET");
    });

    test("a newer run may have less progress; older-run PATCH never replaces its projection", async () => {
        const target = await generation("shared");
        const one = await post(key(), {
            recommendationGenerationId: target.id,
        });
        expect((await engagement(one.body.id, 150)).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const two = await post(key("D".repeat(32)), {
            recommendationGenerationId: target.id,
        });
        expect((await engagement(two.body.id, 10, "skipped")).status).toBe(200);
        expect((await engagement(one.body.id, 180)).status).toBe(200);
        const exposure = await prisma.recommendationExposure.findUniqueOrThrow({
            where: { id: target.exposures[0].id },
        });
        expect(exposure.lastPlayId).toBe(two.body.id);
        expect(exposure.listenedSeconds).toBe(10);
        expect(
            (
                await prisma.play.findUniqueOrThrow({
                    where: { id: one.body.id },
                })
            ).listenedSeconds,
        ).toBe(180);
    });

    test("equal and stale absolute totals keep monotonic outcome priority", async () => {
        const created = await post(key());
        await engagement(created.body.id, 100, "completed");
        expect(
            (await engagement(created.body.id, 100, "skipped")).body.stale,
        ).toBe(true);
        expect(
            (await engagement(created.body.id, 50, "completed")).body.stale,
        ).toBe(true);
        expect(
            (
                await prisma.play.findUniqueOrThrow({
                    where: { id: created.body.id },
                })
            ).outcome,
        ).toBe("completed");
    });

    test("history clear revokes every prior epoch and preserves taste/preferences", async () => {
        const clientPlaybackId = key();
        await post(clientPlaybackId);
        await prisma.userSettings.create({
            data: { userId: owner.id, tasteProfile: { fixture: true } },
        });
        const cleared = await request(app)
            .delete("/api/plays/history?range=all")
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`);
        expect(cleared.body.deletedCount).toBe(1);
        expect((await post(clientPlaybackId)).status).toBe(410);
        expect((await post(key("E".repeat(32), Date.now(), 1))).status).toBe(
            200,
        );
        expect(
            (
                await prisma.userSettings.findUniqueOrThrow({
                    where: { userId: owner.id },
                })
            ).tasteProfile,
        ).toEqual({ fixture: true });
        const receipt = await prisma.playCreationReceipt.findUniqueOrThrow({
            where: {
                userId_clientPlaybackId: { userId: owner.id, clientPlaybackId },
            },
        });
        expect(receipt.playId).toBeNull();
        expect(receipt.requestHash).toBeNull();
        expect(receipt.deletedAt).not.toBeNull();
    });

    test("empty and bounded clear still advance epoch; future outliers keep existing range semantics", async () => {
        await prisma.play.create({
            data: { userId: owner.id, playedAt: new Date(Date.now() + 60_000) },
        });
        const cleared = await request(app)
            .delete("/api/plays/history?range=7d")
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`);
        expect(cleared.body.deletedCount).toBe(0);
        expect(
            (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } }))
                .playHistoryEpoch,
        ).toBe(1);
        expect((await post(key())).status).toBe(410);
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            1,
        );
    });

    test("a deleted Play with a surviving receipt never resurrects", async () => {
        const clientPlaybackId = key();
        const created = await post(clientPlaybackId);
        await prisma.play.delete({ where: { id: created.body.id } });
        expect((await post(clientPlaybackId)).status).toBe(410);
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            0,
        );
    });

    test("receipt failure rolls back Play and attribution together", async () => {
        const target = await generation("rollback");
        await prisma.$executeRawUnsafe(
            `CREATE FUNCTION dev08_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture receipt failure'; END $$`,
        );
        await prisma.$executeRawUnsafe(
            `CREATE TRIGGER dev08_receipt_failure BEFORE INSERT ON "PlayCreationReceipt" FOR EACH ROW EXECUTE FUNCTION dev08_reject_receipt()`,
        );
        try {
            expect(
                (await post(key(), { recommendationGenerationId: target.id }))
                    .status,
            ).toBe(500);
            expect(
                await prisma.play.count({ where: { userId: owner.id } }),
            ).toBe(0);
            expect(
                (
                    await prisma.recommendationExposure.findUniqueOrThrow({
                        where: { id: target.exposures[0].id },
                    })
                ).playedAt,
            ).toBeNull();
        } finally {
            await prisma.$executeRawUnsafe(
                `DROP TRIGGER dev08_receipt_failure ON "PlayCreationReceipt"`,
            );
            await prisma.$executeRawUnsafe(
                `DROP FUNCTION dev08_reject_receipt()`,
            );
        }
    });

    test("receipt pruning is bounded and its watermark rejects rollback-clock replay", async () => {
        const clientPlaybackId = key();
        const created = await post(clientPlaybackId);
        const issuedAt = Number.parseInt(clientPlaybackId.split(".")[2], 36);
        const { createPlayAccounting } =
            require("../src/services/playAccounting") as typeof import("../src/services/playAccounting");
        const collector = createPlayAccounting(
            prisma,
            mockPlayCreationPolicy,
            () => new Date(issuedAt + 24 * 3600_000 + 300_001),
        );
        expect(await collector.pruneExpiredReceipts(owner.id, 1)).toBe(1);
        expect(
            await prisma.play.count({ where: { id: created.body.id } }),
        ).toBe(1);
        const rollback = createPlayAccounting(
            prisma,
            mockPlayCreationPolicy,
            () => new Date(issuedAt + 100),
        );
        await expect(
            rollback.createOrReplay(
                owner.id,
                clientPlaybackId,
                { musicSourceRecording: recording },
                async () => {
                    throw new Error("must not resolve");
                },
            ),
        ).rejects.toMatchObject({ status: 410, code: "play_key_pruned" });
    });

    test("clear during unlocked preparation fences the eventual late create", async () => {
        const { createPlayAccounting } =
            require("../src/services/playAccounting") as typeof import("../src/services/playAccounting");
        const service = createPlayAccounting(prisma, mockPlayCreationPolicy);
        let prepared!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
            prepared = resolve;
        });
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const pending = service.createOrReplay(
            owner.id,
            key(),
            { musicSourceRecording: recording },
            async () => {
                prepared();
                await held;
                return {};
            },
        );
        await entered;
        expect(
            (
                await request(app)
                    .delete("/api/plays/history?range=all")
                    .set("Authorization", `Bearer ${auth.generateToken(owner)}`)
            ).status,
        ).toBe(200);
        release();
        await expect(pending).rejects.toMatchObject({
            status: 410,
            code: "play_history_epoch_changed",
        });
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            0,
        );
    });

    test("replay-only rollback permits an existing receipt and refuses a fresh key", async () => {
        const clientPlaybackId = key();
        const first = await post(clientPlaybackId);
        mockPlayCreationPolicy.newCreationsEnabled = false;
        expect((await post(clientPlaybackId)).body.id).toBe(first.body.id);
        expect((await post(key("F".repeat(32)))).status).toBe(503);
    });

    test("the same key is isolated by owner, and a replay never re-runs preparation", async () => {
        const clientPlaybackId = key();
        const one = await post(clientPlaybackId);
        const other = await prisma.user.create({
            data: {
                id: "dev08-core-other",
                username: "dev08-core-other",
                isTestAccount: true,
            },
        });
        const two = await post(clientPlaybackId, {}, other);
        expect(two.status).toBe(200);
        expect(two.body.id).not.toBe(one.body.id);
        const { createPlayAccounting } =
            require("../src/services/playAccounting") as typeof import("../src/services/playAccounting");
        const prepare = jest.fn(async () => {
            throw new Error("must not prepare a replay");
        });
        expect(
            (
                await createPlayAccounting(
                    prisma,
                    mockPlayCreationPolicy,
                ).createOrReplay(
                    owner.id,
                    clientPlaybackId,
                    { musicSourceRecording: recording },
                    prepare,
                )
            ).id,
        ).toBe(one.body.id);
        expect(prepare).not.toHaveBeenCalled();
    });

    test("bounded history clear deletes only its selected rows and tombstones their receipts", async () => {
        const clientPlaybackId = key();
        const selected = await post(clientPlaybackId);
        const old = await prisma.play.create({
            data: {
                userId: owner.id,
                playedAt: new Date(Date.now() - 40 * 86_400_000),
            },
        });
        const future = await prisma.play.create({
            data: { userId: owner.id, playedAt: new Date(Date.now() + 60_000) },
        });
        const response = await request(app)
            .delete("/api/plays/history?range=30d")
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`);
        expect(response.body.deletedCount).toBe(1);
        expect(
            await prisma.play.findUnique({ where: { id: selected.body.id } }),
        ).toBeNull();
        expect(
            await prisma.play.count({
                where: { id: { in: [old.id, future.id] } },
            }),
        ).toBe(2);
        expect(
            (
                await prisma.playCreationReceipt.findUniqueOrThrow({
                    where: {
                        userId_clientPlaybackId: {
                            userId: owner.id,
                            clientPlaybackId,
                        },
                    },
                })
            ).deletedAt,
        ).not.toBeNull();
    });

    test("legacy projection respects run order and cannot regress the same run's absolute totals", async () => {
        const target = await generation("legacy-order");
        const { projectPlaybackAttribution } =
            require("../src/services/recommendations/playAttribution") as typeof import("../src/services/recommendations/playAttribution");
        const playedAt = new Date();
        const base = {
            exposureId: target.exposures[0].id,
            userId: owner.id,
            playedAt,
        };
        await projectPlaybackAttribution(prisma, {
            ...base,
            playId: "b",
            listenedSeconds: 150,
            completionRatio: 0.75,
            outcome: "completed",
        });
        await projectPlaybackAttribution(prisma, {
            ...base,
            playId: "c",
            listenedSeconds: 10,
            completionRatio: 0.05,
            outcome: "skipped",
        });
        await projectPlaybackAttribution(prisma, {
            ...base,
            playId: "b",
            listenedSeconds: 180,
            completionRatio: 0.9,
            outcome: "completed",
        });
        await projectPlaybackAttribution(prisma, {
            ...base,
            playId: "c",
            listenedSeconds: 5,
            completionRatio: 0.025,
            outcome: "failed",
        });
        expect(
            await prisma.recommendationExposure.findUniqueOrThrow({
                where: { id: base.exposureId },
            }),
        ).toMatchObject({
            lastPlayId: "c",
            listenedSeconds: 10,
            outcome: "skipped",
        });
    });

    test("diagnostic and local-stream keys cannot create an unpaired Play", async () => {
        const token = auth.generateToken(owner);
        expect(
            (
                await request(app)
                    .post("/api/plays/idempotent")
                    .set("Authorization", `Bearer ${token}`)
                    .set("x-soundspan-diagnostic", "playback")
                    .send({
                        clientPlaybackId: key(),
                        musicSourceRecording: recording,
                    })
            ).status,
        ).toBe(400);
        expect(
            (
                await request(app)
                    .post("/api/plays/idempotent")
                    .set("Authorization", `Bearer ${token}`)
                    .send({ clientPlaybackId: key(), trackId: "local-fixture" })
            ).status,
        ).toBe(400);
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            0,
        );
    });
    test("engagement hides another owner's Play behind the existing 404 contract", async () => {
        const other = await prisma.user.create({
            data: {
                id: "dev08-core-foreign",
                username: "dev08-core-foreign",
                isTestAccount: true,
            },
        });
        const foreign = await post(key(), {}, other);
        expect((await engagement(foreign.body.id, 100)).status).toBe(404);
        expect(
            (
                await prisma.play.findUniqueOrThrow({
                    where: { id: foreign.body.id },
                })
            ).listenedSeconds,
        ).toBeNull();
    });
    test("Yandex uses its private native identity and preserves replay", async () => {
        const clientPlaybackId = key();
        const payload = {
            musicSourceRecording: {
                ...recording,
                provider: "yandex",
                id: "123",
            },
        };
        const first = await post(clientPlaybackId, payload);
        expect(first.status).toBe(200);
        expect((await post(clientPlaybackId, payload)).body.id).toBe(
            first.body.id,
        );
        const play = await prisma.play.findUniqueOrThrow({
            where: { id: first.body.id },
            include: { trackMusicSource: true },
        });
        expect(play.source).toBe("YANDEX");
        expect(play.trackMusicSource?.provider).toBe("yandex");
    });

    test("YouTube reuses the real metadata/mapping adapter and replays the receipt", async () => {
        const clientPlaybackId = key();
        const payload = {
            clientPlaybackId,
            youtubeVideoId: "dev08video1",
            title: "Fixture title",
            artist: "Fixture artist",
            album: "Fixture album",
            duration: 200,
        };
        const send = () =>
            request(app)
                .post("/api/plays/idempotent")
                .set("Authorization", `Bearer ${auth.generateToken(owner)}`)
                .send(payload);
        const first = await send();
        expect(first.status).toBe(200);
        expect((await send()).body.id).toBe(first.body.id);
        const play = await prisma.play.findUniqueOrThrow({
            where: { id: first.body.id },
            include: { trackYtMusic: true },
        });
        expect(play.source).toBe("YOUTUBE_MUSIC");
        expect(play.trackYtMusic?.videoId).toBe("dev08video1");
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            1,
        );
    });
    test("adversarial: an in-process caller cannot change the hashed snapshot during preparation", async () => {
        const { createPlayAccounting } =
            require("../src/services/playAccounting") as typeof import("../src/services/playAccounting");
        const service = createPlayAccounting(prisma, mockPlayCreationPolicy);
        const payload = {
            musicSourceRecording: {
                ...recording,
                artists: [...recording.artists],
            },
        };
        const clientPlaybackId = key();
        const first = await service.createOrReplay(
            owner.id,
            clientPlaybackId,
            payload,
            async () => {
                payload.musicSourceRecording.title = "Mutated after admission";
                payload.musicSourceRecording.artists[0] = "Mutated artist";
                return {};
            },
        );
        const stored = await prisma.play.findUniqueOrThrow({
            where: { id: first.id },
        });
        expect(stored.musicSourceRecording).toMatchObject({
            title: recording.title,
            artists: recording.artists,
        });
        expect(
            (
                await service.createOrReplay(
                    owner.id,
                    clientPlaybackId,
                    { musicSourceRecording: recording },
                    async () => {
                        throw new Error("must not prepare");
                    },
                )
            ).id,
        ).toBe(first.id);
    });

    test("adversarial: key expiry during preparation is rechecked before any mutation", async () => {
        const { createPlayAccounting } =
            require("../src/services/playAccounting") as typeof import("../src/services/playAccounting");
        const issuedAt = Date.now();
        let now = issuedAt;
        const service = createPlayAccounting(
            prisma,
            mockPlayCreationPolicy,
            () => new Date(now),
        );
        await expect(
            service.createOrReplay(
                owner.id,
                key("G".repeat(32), issuedAt),
                { musicSourceRecording: recording },
                async () => {
                    now = issuedAt + 24 * 3600_000;
                    return {};
                },
            ),
        ).rejects.toMatchObject({ status: 410, code: "play_key_expired" });
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            0,
        );
        expect(
            await prisma.playCreationReceipt.count({
                where: { userId: owner.id },
            }),
        ).toBe(0);
    });

    test("adversarial: receipt GC respects its exact batch bound and preserves Plays", async () => {
        const oneTime = Date.now() - 2 * 3600_000;
        const twoTime = oneTime + 3600_000;
        await post(key("H".repeat(32), oneTime));
        await post(key("I".repeat(32), twoTime));
        const { createPlayAccounting } =
            require("../src/services/playAccounting") as typeof import("../src/services/playAccounting");
        const service = createPlayAccounting(
            prisma,
            mockPlayCreationPolicy,
            () => new Date(twoTime + 25 * 3600_000),
        );
        expect(await service.pruneExpiredReceipts(owner.id, 1)).toBe(1);
        expect(
            await prisma.playCreationReceipt.count({
                where: { userId: owner.id },
            }),
        ).toBe(1);
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            2,
        );
        expect(
            (
                await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })
            ).playReceiptPrunedThrough?.getTime(),
        ).toBe(oneTime);
    });

    test("adversarial: exhausted history epoch fails closed without deleting or resetting", async () => {
        await prisma.user.update({
            where: { id: owner.id },
            data: { playHistoryEpoch: 2_147_483_647 },
        });
        const first = await post(
            key("J".repeat(32), Date.now(), 2_147_483_647),
        );
        expect(first.status).toBe(200);
        const cleared = await request(app)
            .delete("/api/plays/history?range=all")
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`);
        expect(cleared.status).toBe(503);
        expect(cleared.body.code).toBe("play_history_epoch_exhausted");
        expect(await prisma.play.count({ where: { userId: owner.id } })).toBe(
            1,
        );
        expect(
            (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } }))
                .playHistoryEpoch,
        ).toBe(2_147_483_647);
    });
});
