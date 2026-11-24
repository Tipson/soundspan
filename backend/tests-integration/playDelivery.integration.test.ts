import express from "express";
import request from "supertest";
import { createPlayDeliveryTestDatabase } from "./playDeliveryTestDatabase";

const integrationUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = integrationUrl ? describe : describe.skip;
const mockPolicy = {
    newCreationsEnabled: true,
    replaySupported: true,
    newCreationUserIds: ["delivery-owner"],
};
jest.mock("../src/config", () => {
    const actual = jest.requireActual("../src/config");
    return {
        ...actual,
        config: { ...actual.config, playCreation: mockPolicy },
    };
});

suite("durable Play delivery on an isolated phase PostgreSQL database", () => {
    let fixture: Awaited<ReturnType<typeof createPlayDeliveryTestDatabase>>;
    let prisma: typeof import("../src/utils/db").prisma;
    let auth: typeof import("../src/middleware/auth");
    let app: express.Express;
    let owner: {
        id: string;
        username: string;
        role: string;
        tokenVersion: number;
    };
    const youtube = {
        youtubeVideoId: "dev08deliver1",
        title: "Fixture title",
        artist: "Fixture artist",
        album: "Fixture album",
        duration: 200,
    };
    const key = () => `p1.0.${Date.now().toString(36)}.${"D".repeat(32)}`;

    beforeAll(async () => {
        fixture = await createPlayDeliveryTestDatabase(integrationUrl!);
        prisma = (
            require("../src/utils/db") as typeof import("../src/utils/db")
        ).prisma;
        auth = require("../src/middleware/auth") as typeof auth;
        app = express();
        app.use(express.json());
        app.use(
            "/api/plays",
            (
                require("../src/routes/plays") as typeof import("../src/routes/plays")
            ).default,
        );
    }, 660_000);

    beforeEach(async () => {
        await prisma.user.deleteMany({ where: { id: "delivery-owner" } });
        owner = await prisma.user.create({
            data: {
                id: "delivery-owner",
                username: "delivery-owner",
                isTestAccount: true,
            },
        });
        await prisma.scrobbleConnection.createMany({
            data: ["lastfm", "listenbrainz"].map((service) => ({
                userId: owner.id,
                service,
                encryptedCredential: "synthetic-not-used-before-worker",
                enabled: true,
            })),
        });
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
        if (fixture) await fixture.close();
    });

    function post(
        clientPlaybackId: string,
        payload: Record<string, unknown> = youtube,
    ) {
        return request(app)
            .post("/api/plays/idempotent")
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`)
            .send({ clientPlaybackId, ...payload });
    }

    test("one accepted/replayed YouTube Play owns one intent per original destination", async () => {
        const clientPlaybackId = key();
        const created = await post(clientPlaybackId);
        expect(created.status).toBe(200);
        expect((await post(clientPlaybackId)).body.id).toBe(created.body.id);
        const intents = await prisma.playScrobbleDispatch.findMany({
            where: { userId: owner.id },
        });
        expect(intents).toHaveLength(2);
        expect(intents.map((intent) => intent.service).sort()).toEqual([
            "lastfm",
            "listenbrainz",
        ]);
        expect(
            intents.every(
                (intent) =>
                    intent.playId === created.body.id &&
                    intent.state === "PENDING" &&
                    intent.connectionId &&
                    intent.authEpoch === 0,
            ),
        ).toBe(true);
    });

    test.each(["vk", "yandex"] as const)(
        "%s owner-only snapshots never acquire external intents",
        async (provider) => {
            const created = await post(key(), {
                musicSourceRecording: {
                    provider,
                    id: provider === "vk" ? "-1_2" : "123",
                    title: "Private title",
                    artists: ["Private artist"],
                    duration: 200,
                    contentVersion: "unknown",
                    preview: false,
                },
            });
            expect(created.status).toBe(200);
            expect(
                await prisma.playScrobbleDispatch.count({
                    where: { userId: owner.id },
                }),
            ).toBe(0);
        },
    );

    test("concurrent duplicate creation commits one Play and two destination intents", async () => {
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
        expect(
            await prisma.playScrobbleDispatch.count({
                where: { userId: owner.id },
            }),
        ).toBe(2);
    });

    test("intent insertion failure rolls back Play and receipt instead of losing the obligation", async () => {
        await prisma.$executeRawUnsafe(
            `CREATE FUNCTION delivery_reject_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture intent failure'; END $$`,
        );
        await prisma.$executeRawUnsafe(
            `CREATE TRIGGER delivery_intent_failure BEFORE INSERT ON "PlayScrobbleDispatch" FOR EACH ROW EXECUTE FUNCTION delivery_reject_intent()`,
        );
        try {
            expect((await post(key())).status).toBe(500);
            expect(
                await prisma.play.count({ where: { userId: owner.id } }),
            ).toBe(0);
            expect(
                await prisma.playCreationReceipt.count({
                    where: { userId: owner.id },
                }),
            ).toBe(0);
        } finally {
            await prisma.$executeRawUnsafe(
                `DROP TRIGGER delivery_intent_failure ON "PlayScrobbleDispatch"`,
            );
            await prisma.$executeRawUnsafe(
                `DROP FUNCTION delivery_reject_intent()`,
            );
        }
    });

    async function seedPending() {
        const connection = await prisma.scrobbleConnection.findUniqueOrThrow({
            where: {
                userId_service: { userId: owner.id, service: "listenbrainz" },
            },
        });
        const play = await prisma.play.create({
            data: { userId: owner.id, localAttributionState: "NO_TARGET" },
        });
        const { playScrobbleDispatchId } =
            require("../src/services/playScrobbleProtocol") as typeof import("../src/services/playScrobbleProtocol");
        return prisma.playScrobbleDispatch.create({
            data: {
                id: playScrobbleDispatchId(
                    play.id,
                    connection.id,
                    connection.authEpoch,
                ),
                userId: owner.id,
                playId: play.id,
                connectionId: connection.id,
                authEpoch: connection.authEpoch,
                userTokenVersion: owner.tokenVersion,
                service: "listenbrainz",
                listenedAt: play.playedAt,
                metadata: {
                    artist: "Fixture artist",
                    title: "Fixture title",
                    durationSeconds: 200,
                },
                expiresAt: new Date(Date.now() + 86_400_000),
            },
        });
    }

    test("history clear cancels selected PENDING and removes its metadata", async () => {
        const row = await seedPending();
        const cleared = await request(app)
            .delete("/api/plays/history?range=all")
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`);
        expect(cleared.status).toBe(200);
        expect(
            await prisma.playScrobbleDispatch.findUniqueOrThrow({
                where: { id: row.id },
            }),
        ).toMatchObject({ state: "CANCELLED", metadata: null, playId: null });
    });

    test("disable/enable retires an authorization generation without rerouting the old intent", async () => {
        const row = await seedPending();
        const { setScrobblerEnabled } =
            require("../src/services/scrobbleConnections") as typeof import("../src/services/scrobbleConnections");
        expect(await setScrobblerEnabled(owner.id, "listenbrainz", false)).toBe(
            true,
        );
        expect(await setScrobblerEnabled(owner.id, "listenbrainz", true)).toBe(
            true,
        );
        expect(
            (
                await prisma.scrobbleConnection.findUniqueOrThrow({
                    where: { id: row.connectionId! },
                })
            ).authEpoch,
        ).toBe(2);
        expect(
            await prisma.playScrobbleDispatch.findUniqueOrThrow({
                where: { id: row.id },
            }),
        ).toMatchObject({ state: "CANCELLED", metadata: null });
    });

    function worker(
        submit = jest.fn().mockResolvedValue("submitted"),
        clock = () => new Date(),
    ) {
        const {
            createPlayScrobbleDispatcher,
        } = require("../src/workers/playScrobbleDispatch");
        return {
            process: createPlayScrobbleDispatcher(prisma, {
                clock,
                submit,
                decryptCredential: () => "synthetic-credential",
                resolveLastFmCredentials: async () => ({
                    apiKey: "synthetic",
                    sharedSecret: "synthetic",
                }),
            }),
            submit,
        };
    }
    const wake = (row: { id: string; userId: string }) => ({
        version: 1,
        dispatchId: row.id,
        userId: row.userId,
    });
    const readDispatch = (id: string) =>
        prisma.playScrobbleDispatch.findUniqueOrThrow({ where: { id } });

    test("duplicate wakeups claim once and terminal ACK erases metadata", async () => {
        const row = await seedPending();
        const w = worker();
        await Promise.all([w.process(wake(row)), w.process(wake(row))]);
        await w.process(wake(row));
        expect(w.submit).toHaveBeenCalledTimes(1);
        expect(await readDispatch(row.id)).toMatchObject({
            state: "SUBMITTED",
            metadata: null,
            attemptCount: 1,
            claimToken: null,
        });
    });

    test("wake owner mismatch and unknown payload fields cannot send", async () => {
        const row = await seedPending();
        const w = worker();
        await w.process({ ...wake(row), userId: "another-owner" });
        await w.process({ ...wake(row), credential: "never-allowed" });
        expect(w.submit).not.toHaveBeenCalled();
        expect((await readDispatch(row.id)).state).toBe("PENDING");
    });

    test("unknown ACK never retries, including after repeated wakeups", async () => {
        const row = await seedPending();
        const w = worker(jest.fn().mockResolvedValue("ambiguous"));
        await w.process(wake(row));
        await w.process(wake(row));
        expect(w.submit).toHaveBeenCalledTimes(1);
        expect(await readDispatch(row.id)).toMatchObject({
            state: "AMBIGUOUS",
            metadata: null,
        });
    });

    test("proved before-handoff errors permit three bounded attempts and no fourth", async () => {
        const row = await seedPending();
        const {
            ScrobbleBeforeHandoffError,
        } = require("../src/services/playScrobbleSubmission");
        let now = new Date();
        const w = worker(
            jest
                .fn()
                .mockRejectedValue(
                    new ScrobbleBeforeHandoffError("configuration_unavailable"),
                ),
            () => now,
        );
        for (let attempt = 1; attempt <= 3; attempt++) {
            await w.process(wake(row));
            const current = await readDispatch(row.id);
            expect(current.attemptCount).toBe(attempt);
            if (attempt < 3) {
                expect(current.state).toBe("PENDING");
                now = new Date(current.availableAt.getTime() + 1);
            } else
                expect(current).toMatchObject({
                    state: "FAILED_NOT_SENT",
                    metadata: null,
                });
        }
        await w.process(wake(row));
        expect(w.submit).toHaveBeenCalledTimes(3);
    });

    test("same-row reauthorization and security token revocation cannot redirect an intent", async () => {
        const row = await seedPending();
        await prisma.scrobbleConnection.update({
            where: { id: row.connectionId! },
            data: {
                authEpoch: { increment: 1 },
                encryptedCredential: "new-account",
            },
        });
        const w = worker();
        await w.process(wake(row));
        expect(w.submit).not.toHaveBeenCalled();
        expect(await readDispatch(row.id)).toMatchObject({
            state: "CANCELLED",
            metadata: null,
        });
        const next = await seedPending();
        await prisma.user.update({
            where: { id: owner.id },
            data: { tokenVersion: { increment: 1 } },
        });
        await w.process(wake(next));
        expect(w.submit).not.toHaveBeenCalled();
        expect((await readDispatch(next.id)).state).toBe("CANCELLED");
    });

    test("clear after claim while preparing stops transport; a late ACK cannot resurrect cancellation", async () => {
        const row = await seedPending();
        const {
            createPlayScrobbleDispatcher,
        } = require("../src/workers/playScrobbleDispatch");
        let prepared!: () => void;
        let entered!: () => void;
        const preparationEntered = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const preparation = new Promise<string>((resolve) => {
            prepared = () => resolve("synthetic");
        });
        const submit = jest.fn().mockResolvedValue("submitted");
        const process = createPlayScrobbleDispatcher(prisma, {
            submit,
            decryptCredential: async () => {
                entered();
                return preparation;
            },
            resolveLastFmCredentials: jest.fn(),
        });
        const dispatch = process(wake(row));
        await preparationEntered;
        expect((await readDispatch(row.id)).state).toBe("CLAIMED");
        const cleared = await request(app)
            .delete("/api/plays/history?range=all")
            .set("Authorization", `Bearer ${auth.generateToken(owner)}`);
        expect(cleared.status).toBe(200);
        prepared();
        await dispatch;
        expect(submit).not.toHaveBeenCalled();
        expect(await readDispatch(row.id)).toMatchObject({
            state: "AMBIGUOUS",
            metadata: null,
            playId: null,
        });
    });

    test("external call holds no owner lock and connection revocation wins over late success", async () => {
        const row = await seedPending();
        let received!: () => void;
        const receiving = new Promise<void>((resolve) => {
            received = resolve;
        });
        let ack!: () => void;
        const submit = jest.fn(() => {
            received();
            return new Promise<string>((resolve) => {
                ack = () => resolve("submitted");
            });
        });
        const w = worker(submit);
        const dispatch = w.process(wake(row));
        await receiving;
        const {
            setScrobblerEnabled,
        } = require("../src/services/scrobbleConnections");
        expect(await setScrobblerEnabled(owner.id, "listenbrainz", false)).toBe(
            true,
        );
        ack();
        await dispatch;
        expect(await readDispatch(row.id)).toMatchObject({
            state: "AMBIGUOUS",
            metadata: null,
        });
    });

    test("stale invalid-auth cannot disable a reauthenticated generation", async () => {
        const row = await seedPending();
        let received!: () => void;
        const receiving = new Promise<void>((resolve) => {
            received = resolve;
        });
        let ack!: () => void;
        const w = worker(
            jest.fn(() => {
                received();
                return new Promise<string>((resolve) => {
                    ack = () => resolve("invalid_auth");
                });
            }),
        );
        const dispatch = w.process(wake(row));
        await receiving;
        await prisma.scrobbleConnection.update({
            where: { id: row.connectionId! },
            data: {
                encryptedCredential: "replacement",
                authEpoch: { increment: 1 },
            },
        });
        ack();
        await dispatch;
        expect(
            await prisma.scrobbleConnection.findUniqueOrThrow({
                where: { id: row.connectionId! },
            }),
        ).toMatchObject({ enabled: true, authEpoch: 1 });
    });

    test("expired CLAIMED recovery is terminal; Redis failure preserves due obligations", async () => {
        const claimed = await seedPending();
        await prisma.playScrobbleDispatch.update({
            where: { id: claimed.id },
            data: {
                state: "CLAIMED",
                claimToken: "synthetic-claim",
                claimExpiresAt: new Date(Date.now() - 1),
            },
        });
        const pending = await seedPending();
        const {
            createPlayScrobbleMaintenance,
        } = require("../src/workers/playScrobbleDispatchMaintenance");
        const enqueue = jest
            .fn()
            .mockRejectedValueOnce(new Error("synthetic Redis ACK loss"))
            .mockResolvedValue(undefined);
        const tick = createPlayScrobbleMaintenance(prisma, {
            enqueue,
            pruneReceipts: jest.fn(),
        });
        expect(await tick()).toMatchObject({
            recovered: 1,
            enqueueFailures: 1,
        });
        expect((await readDispatch(claimed.id)).state).toBe("AMBIGUOUS");
        expect((await readDispatch(pending.id)).state).toBe("PENDING");
        expect(await tick()).toMatchObject({ enqueued: 1 });
        const w = worker();
        await w.process(wake(claimed));
        expect(w.submit).not.toHaveBeenCalled();
    });

    test.each(["lastfm", "listenbrainz"] as const)(
        "%s actual TLS accept+ACK or lost ACK is durable and never resent",
        async (service) => {
            const {
                createPlayDeliveryTlsPeer,
            } = require("./playDeliveryTlsPeer");
            for (const lostAck of [false, true]) {
                const row = await seedPending();
                const connection =
                    await prisma.scrobbleConnection.findUniqueOrThrow({
                        where: {
                            userId_service: { userId: owner.id, service },
                        },
                    });
                await prisma.playScrobbleDispatch.update({
                    where: { id: row.id },
                    data: { connectionId: connection.id, service },
                });
                const peer = await createPlayDeliveryTlsPeer(service, lostAck);
                try {
                    const w = worker(peer.submit);
                    await Promise.all([
                        w.process(wake(row)),
                        w.process(wake(row)),
                    ]);
                    await w.process(wake(row));
                    expect(peer.received()).toBe(1);
                    expect(await readDispatch(row.id)).toMatchObject({
                        state: lostAck ? "AMBIGUOUS" : "SUBMITTED",
                        metadata: null,
                    });
                } finally {
                    await peer.close();
                }
            }
        },
    );

    test("accept before database ACK failure leaves a claim that recovery never resends", async () => {
        const row = await seedPending();
        const { createPlayDeliveryTlsPeer } = require("./playDeliveryTlsPeer");
        const peer = await createPlayDeliveryTlsPeer("listenbrainz");
        await prisma.$executeRawUnsafe(
            `CREATE FUNCTION delivery_reject_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'SUBMITTED' THEN RAISE EXCEPTION 'fixture ack failure'; END IF; RETURN NEW; END $$`,
        );
        await prisma.$executeRawUnsafe(
            `CREATE TRIGGER delivery_ack_failure BEFORE UPDATE ON "PlayScrobbleDispatch" FOR EACH ROW EXECUTE FUNCTION delivery_reject_ack()`,
        );
        try {
            const w = worker(peer.submit);
            await expect(w.process(wake(row))).rejects.toThrow();
            expect(peer.received()).toBe(1);
            expect((await readDispatch(row.id)).state).toBe("CLAIMED");
            await prisma.playScrobbleDispatch.update({
                where: { id: row.id },
                data: { claimExpiresAt: new Date(Date.now() - 1) },
            });
            const {
                createPlayScrobbleMaintenance,
            } = require("../src/workers/playScrobbleDispatchMaintenance");
            await createPlayScrobbleMaintenance(prisma, {
                enqueue: jest.fn(),
                pruneReceipts: jest.fn(),
            })();
            await w.process(wake(row));
            expect(peer.received()).toBe(1);
            expect(await readDispatch(row.id)).toMatchObject({
                state: "AMBIGUOUS",
                metadata: null,
            });
        } finally {
            await prisma.$executeRawUnsafe(
                `DROP TRIGGER delivery_ack_failure ON "PlayScrobbleDispatch"`,
            );
            await prisma.$executeRawUnsafe(
                `DROP FUNCTION delivery_reject_ack()`,
            );
            await peer.close();
        }
    });

    test("one receipt GC tick removes at most 100 across at most ten owners and preserves the prune fence after clock rollback", async () => {
        const ids = Array.from(
            { length: 12 },
            (_, index) => `delivery-gc-owner-${String(index).padStart(2, "0")}`,
        );
        const issuedAt = Date.now() - 86_800_000;
        try {
            await prisma.user.createMany({
                data: ids.map((id) => ({
                    id,
                    username: id,
                    isTestAccount: true,
                })),
            });
            await prisma.playCreationReceipt.createMany({
                data: ids.flatMap((userId) =>
                    Array.from({ length: 20 }, (_, index) => ({
                        userId,
                        clientPlaybackId: `gc-${index}`,
                        requestHash: null,
                        issuedAt: new Date(issuedAt + index),
                        expiresAt: new Date(issuedAt + 86_400_000 + index),
                    })),
                ),
            });
            const {
                createPlayScrobbleMaintenance,
            } = require("../src/workers/playScrobbleDispatchMaintenance");
            const {
                createPlayAccounting,
            } = require("../src/services/playAccounting");
            const accounting = createPlayAccounting(prisma, mockPolicy);
            const pruneReceipts = jest.fn((userId: string, limit: number) =>
                accounting.pruneExpiredReceipts(userId, limit),
            );
            const tick = createPlayScrobbleMaintenance(prisma, {
                enqueue: jest.fn(),
                pruneReceipts,
            });
            expect(await tick()).toMatchObject({ receipts: 100 });
            expect(pruneReceipts.mock.calls.length).toBeLessThanOrEqual(10);
            expect(
                await prisma.playCreationReceipt.count({
                    where: { userId: { in: ids } },
                }),
            ).toBe(140);
            const first = await prisma.user.findUniqueOrThrow({
                where: { id: ids[0] },
            });
            expect(first.playReceiptPrunedThrough).not.toBeNull();
            const rollback = createPlayAccounting(
                prisma,
                mockPolicy,
                () => new Date(issuedAt + 100),
            );
            const oldKey = `p1.0.${issuedAt.toString(36)}.${"G".repeat(32)}`;
            await expect(
                rollback.createOrReplay(ids[0], oldKey, youtube, jest.fn()),
            ).rejects.toMatchObject({ status: 410, code: "play_key_pruned" });
            await tick();
            expect(
                await prisma.playCreationReceipt.count({
                    where: { userId: { in: ids } },
                }),
            ).toBe(40);
            await tick();
            expect(
                await prisma.playCreationReceipt.count({
                    where: { userId: ids[11] },
                }),
            ).toBe(0);
        } finally {
            await prisma.user.deleteMany({ where: { id: { in: ids } } });
        }
    });

    test("maintenance checks its elapsed budget between batches and never starts a detached mutation", async () => {
        const row = await seedPending();
        let elapsed = 0;
        const {
            createPlayScrobbleMaintenance,
        } = require("../src/workers/playScrobbleDispatchMaintenance");
        const enqueue = jest.fn(async () => {
            elapsed = 15_001;
        });
        const pruneReceipts = jest.fn();
        const summary = await createPlayScrobbleMaintenance(prisma, {
            enqueue,
            pruneReceipts,
            monotonicNow: () => elapsed,
        })();
        expect(summary).toMatchObject({ enqueued: 1, receipts: 0, purged: 0 });
        expect(pruneReceipts).not.toHaveBeenCalled();
        expect((await readDispatch(row.id)).state).toBe("PENDING");
    });

    test("unresponsive Redis cannot spend the whole tick budget before receipt GC", async () => {
        for (let index = 0; index < 9; index++) await seedPending();
        await prisma.playCreationReceipt.create({
            data: {
                userId: owner.id,
                clientPlaybackId: "expired-during-redis-outage",
                requestHash: null,
                issuedAt: new Date(Date.now() - 86_800_000),
                expiresAt: new Date(Date.now() - 400_000),
            },
        });
        const {
            createPlayScrobbleMaintenance,
        } = require("../src/workers/playScrobbleDispatchMaintenance");
        const {
            createPlayAccounting,
        } = require("../src/services/playAccounting");
        const accounting = createPlayAccounting(prisma, mockPolicy);
        let elapsed = 0;
        const enqueue = jest.fn(async () => {
            elapsed += 2_000;
            throw new Error("synthetic command timeout");
        });
        const tick = createPlayScrobbleMaintenance(prisma, {
            enqueue,
            monotonicNow: () => elapsed,
            pruneReceipts: (userId: string, limit: number) =>
                accounting.pruneExpiredReceipts(userId, limit),
        });
        expect(await tick()).toMatchObject({ enqueueFailures: 1, receipts: 1 });
        expect(
            await prisma.playScrobbleDispatch.count({
                where: { userId: owner.id, state: "PENDING" },
            }),
        ).toBe(9);
    });

    test("validated same-row reauth and disconnect/reconnect permanently retire previous targets", async () => {
        const axios = require("axios").default;
        const provider = jest.spyOn(axios, "get").mockResolvedValue({
            data: { valid: true, user_name: "synthetic-listener" },
        });
        const {
            saveListenBrainzToken,
            disconnectScrobbler,
        } = require("../src/services/scrobbleConnections");
        const original = await seedPending();
        try {
            await saveListenBrainzToken(owner.id, "synthetic-replacement");
            expect(
                await prisma.scrobbleConnection.findUniqueOrThrow({
                    where: { id: original.connectionId! },
                }),
            ).toMatchObject({ authEpoch: 1, enabled: true });
            expect(await readDispatch(original.id)).toMatchObject({
                state: "CANCELLED",
                metadata: null,
            });
            const next = await seedPending();
            await disconnectScrobbler(owner.id, "listenbrainz");
            await saveListenBrainzToken(owner.id, "synthetic-other-account");
            const replacement =
                await prisma.scrobbleConnection.findUniqueOrThrow({
                    where: {
                        userId_service: {
                            userId: owner.id,
                            service: "listenbrainz",
                        },
                    },
                });
            expect(replacement.id).not.toBe(original.connectionId);
            expect(await readDispatch(next.id)).toMatchObject({
                state: "CANCELLED",
                metadata: null,
                connectionId: null,
            });
            const w = worker();
            await w.process(wake(original));
            await w.process(wake(next));
            expect(w.submit).not.toHaveBeenCalled();
        } finally {
            provider.mockRestore();
        }
    });

    test("current invalid auth disables only its generation and cancels sibling pending intents", async () => {
        const row = await seedPending();
        const sibling = await seedPending();
        const w = worker(jest.fn().mockResolvedValue("invalid_auth"));
        await w.process(wake(row));
        expect(await readDispatch(row.id)).toMatchObject({
            state: "INVALID_AUTH",
            metadata: null,
        });
        expect(await readDispatch(sibling.id)).toMatchObject({
            state: "CANCELLED",
            metadata: null,
        });
        expect(
            await prisma.scrobbleConnection.findUniqueOrThrow({
                where: { id: row.connectionId! },
            }),
        ).toMatchObject({ enabled: false, authEpoch: 1 });
    });

    test("acquisition observation begins before a real owner-lock wait and replay never starts a write", async () => {
        const createdKey = key();
        expect((await post(createdKey)).status).toBe(200);
        const { Client } = require("pg");
        const blocker = new Client({
            connectionString: process.env.DATABASE_URL,
        });
        await blocker.connect();
        const {
            createPlayAccounting,
        } = require("../src/services/playAccounting");
        const accounting = createPlayAccounting(prisma, mockPolicy);
        const acquired = jest.fn();
        const failed = jest.fn();
        const observeWrite = jest.fn();
        const prepare = jest.fn();
        const observeReadLock = jest.fn(() => ({ acquired, failed }));
        let replay: Promise<unknown> | undefined;
        try {
            await blocker.query("BEGIN");
            await blocker.query(
                'SELECT "id" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE',
                [owner.id],
            );
            replay = accounting.createOrReplay(
                owner.id,
                createdKey,
                youtube,
                prepare,
                observeWrite,
                observeReadLock,
            );
            let locked = false;
            for (let attempt = 0; attempt < 100; attempt++) {
                const waits = await blocker.query(
                    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()",
                );
                if (waits.rows[0].n > 0) {
                    locked = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(locked).toBe(true);
            expect(observeReadLock).toHaveBeenCalledTimes(1);
            expect(acquired).not.toHaveBeenCalled();
            expect(observeWrite).not.toHaveBeenCalled();
            await blocker.query("COMMIT");
            await expect(replay).resolves.toMatchObject({
                playCreation: { disposition: "replayed" },
            });
            expect(acquired).toHaveBeenCalledTimes(1);
            expect(failed).not.toHaveBeenCalled();
            expect(observeWrite).not.toHaveBeenCalled();
            expect(prepare).not.toHaveBeenCalled();
        } finally {
            await blocker.query("ROLLBACK");
            if (replay) await replay.catch(() => {});
            await blocker.end();
        }
    });
});
