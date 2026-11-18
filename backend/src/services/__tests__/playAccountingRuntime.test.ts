import type { PrismaClient } from "@prisma/client";

jest.mock("../../config", () => ({
    config: {
        playCreation: { newCreationsEnabled: false, replaySupported: false },
    },
}));
jest.mock("../../utils/db", () => ({ prisma: {} }));

import { createPlayAccounting } from "../playAccounting";
import { hashPlayCreationRequest } from "../playAccountingProtocol";

const now = new Date(1_700_000_000_000);
const key = `p1.7.${now.getTime().toString(36)}.${"A".repeat(32)}`;
const payload = {
    youtubeVideoId: "fixtureVideo1",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration: 180,
};
const engagement = {
    listenedSeconds: 90,
    completionRatio: 0.5,
    outcome: "meaningful" as const,
};

function fixture() {
    const owner = {
        id: "alice",
        epoch: 7,
        prunedThrough: null as Date | null,
        tokenVersion: 2,
    };
    const tx = {
        $queryRaw: jest.fn().mockImplementation(async () => [owner]),
        user: {
            findUniqueOrThrow: jest.fn().mockResolvedValue({ tokenVersion: 2 }),
            update: jest.fn().mockResolvedValue({}),
        },
        play: {
            create: jest.fn().mockImplementation(async ({ data }) => ({
                id: "play-1",
                ...data,
            })),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findFirst: jest.fn().mockResolvedValue({
                id: "play-1",
                userId: "alice",
                localAttributionState: "APPLIED",
                attributedExposureId: "exposure-1",
                playedAt: now,
            }),
            deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
        },
        playCreationReceipt: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findMany: jest.fn().mockResolvedValue([]),
            deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        trackMusicSource: {
            upsert: jest.fn().mockResolvedValue({ id: "native-1" }),
        },
        recommendationGeneration: {
            findFirst: jest.fn().mockResolvedValue({ id: "generation-1" }),
        },
        recommendationExposure: {
            findFirst: jest.fn().mockResolvedValue({ id: "exposure-1" }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        scrobbleConnection: {
            findMany: jest
                .fn()
                .mockResolvedValue([
                    { id: "lastfm-1", service: "lastfm", authEpoch: 3 },
                ]),
        },
        playScrobbleDispatch: {
            create: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
    };
    const database = {
        user: tx.user,
        $transaction: jest.fn().mockImplementation(async (work) => work(tx)),
    };
    const policy = {
        newCreationsEnabled: true,
        replaySupported: true,
        newCreationUserIds: ["alice"] as readonly string[] | undefined,
    };
    const service = createPlayAccounting(
        database as unknown as PrismaClient,
        policy,
        () => now,
    );
    const prepare = jest.fn().mockResolvedValue({
        trackYtMusicId: "youtube-1",
        deliveryTrack: {
            title: "Resolved song",
            artist: "Resolved artist",
            durationSeconds: 180,
        },
    });
    const receipt = {
        playId: "previous-play",
        deletedAt: null,
        requestHash: hashPlayCreationRequest(payload),
    };
    return { tx, database, owner, policy, service, prepare, receipt };
}

test("cohort capabilities admit only the exact authenticated owner without exposing the list", async () => {
    const f = fixture();
    f.policy.newCreationUserIds = ["alice"];
    f.tx.user.findUniqueOrThrow.mockResolvedValue({ playHistoryEpoch: 7 });
    for (const userId of ["bob", "Alice", "alice-extra", "alice "]) {
        const capabilities = await f.service.capabilities(userId);
        expect(capabilities).toMatchObject({
            newCreationsEnabled: false,
            replaySupported: true,
            allowedSources: [],
        });
        expect(capabilities).not.toHaveProperty("newCreationUserIds");
    }
    expect(await f.service.capabilities("alice")).toMatchObject({
        newCreationsEnabled: true,
        replaySupported: true,
        allowedSources: ["youtube", "vk", "yandex"],
    });
});

test.each([{ users: undefined }, { users: [] }, { users: ["bob"] }])(
    "a non-cohort new key cannot prepare metadata or write a Play ($users)",
    async ({ users }) => {
        const f = fixture();
        f.policy.newCreationUserIds = users;
        await expect(
            f.service.createOrReplay("alice", key, payload, f.prepare),
        ).rejects.toMatchObject({ status: 503 });
        expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(f.prepare).not.toHaveBeenCalled();
        expect(f.tx.play.create).not.toHaveBeenCalled();
        expect(f.tx.playCreationReceipt.create).not.toHaveBeenCalled();
        expect(f.tx.playScrobbleDispatch.create).not.toHaveBeenCalled();
    },
);

test("creation never advertises or writes when receipt recovery is disabled", async () => {
    const f = fixture();
    f.policy.replaySupported = false;
    f.tx.user.findUniqueOrThrow.mockResolvedValue({ playHistoryEpoch: 7 });
    expect(await f.service.capabilities("alice")).toMatchObject({
        newCreationsEnabled: false,
        replaySupported: false,
        allowedSources: [],
    });
    await expect(
        f.service.createOrReplay("alice", key, payload, f.prepare),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.tx.play.create).not.toHaveBeenCalled();
});

test.each(["cohort removal", "producer rollback"])(
    "%s is rechecked under the second owner lock after preparation",
    async (change) => {
        const f = fixture();
        f.policy.newCreationUserIds = ["alice"];
        f.prepare.mockImplementation(async () => {
            if (change === "cohort removal")
                f.policy.newCreationUserIds = ["bob"];
            else f.policy.newCreationsEnabled = false;
            return { trackYtMusicId: "youtube-1" };
        });
        await expect(
            f.service.createOrReplay("alice", key, payload, f.prepare),
        ).rejects.toMatchObject({ status: 503 });
        expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(f.prepare).toHaveBeenCalledTimes(1);
        expect(f.tx.play.create).not.toHaveBeenCalled();
        expect(f.tx.playCreationReceipt.create).not.toHaveBeenCalled();
    },
);

test.each([true, false])(
    "a stored receipt replays outside the cohort while new producers enabled=%s",
    async (enabled) => {
        const f = fixture();
        f.policy.newCreationUserIds = [];
        f.policy.newCreationsEnabled = enabled;
        f.tx.playCreationReceipt.findUnique.mockResolvedValue(f.receipt);
        await expect(
            f.service.createOrReplay("alice", key, payload, f.prepare),
        ).resolves.toMatchObject({
            id: "previous-play",
            playCreation: { disposition: "replayed" },
        });
        expect(f.prepare).not.toHaveBeenCalled();
        expect(f.tx.play.create).not.toHaveBeenCalled();
    },
);

test("enabled capabilities advertise only supported sources and a fresh server clock", async () => {
    const f = fixture();
    f.tx.user.findUniqueOrThrow.mockResolvedValue({ playHistoryEpoch: 7 });
    jest.useFakeTimers().setSystemTime(now);
    try {
        const service = createPlayAccounting(
            f.tx as unknown as PrismaClient,
            f.policy,
        );
        expect(await service.capabilities("alice")).toMatchObject({
            ownerHistoryEpoch: 7,
            serverNowMs: now.getTime(),
            allowedSources: ["youtube", "vk", "yandex"],
            newCreationsEnabled: true,
            replaySupported: true,
        });
    } finally {
        jest.useRealTimers();
    }
});

test("a replay bypasses metadata and writes, while observing only the acquired read lock", async () => {
    const f = fixture();
    f.tx.playCreationReceipt.findUnique.mockResolvedValue(f.receipt);
    const write = jest.fn();
    const read = { acquired: jest.fn(), failed: jest.fn() };
    const result = await f.service.createOrReplay(
        "alice",
        key,
        payload,
        f.prepare,
        write,
        () => read,
    );
    expect(result).toMatchObject({
        id: "previous-play",
        playCreation: { clientPlaybackId: key, disposition: "replayed" },
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.tx.play.create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(read.acquired).toHaveBeenCalledTimes(1);
    expect(read.failed).not.toHaveBeenCalled();
});

test.each([
    { change: { deletedAt: now }, status: 410 },
    { change: { playId: null }, status: 410 },
    { change: { requestHash: "different-payload" }, status: 409 },
])(
    "an incompatible receipt fails closed before provider preparation: $status/$change",
    async ({ change, status }) => {
        const f = fixture();
        f.tx.playCreationReceipt.findUnique.mockResolvedValue({
            ...f.receipt,
            ...change,
        });
        await expect(
            f.service.createOrReplay("alice", key, payload, f.prepare),
        ).rejects.toMatchObject({ status });
        expect(f.prepare).not.toHaveBeenCalled();
        expect(f.tx.play.create).not.toHaveBeenCalled();
    },
);

test("rechecks history invalidation after metadata returns", async () => {
    const f = fixture();
    f.prepare.mockImplementation(async () => {
        f.owner.epoch = 8;
        return { trackYtMusicId: "youtube-1" };
    });
    await expect(
        f.service.createOrReplay("alice", key, payload, f.prepare),
    ).rejects.toMatchObject({ status: 410 });
    expect(f.tx.play.create).not.toHaveBeenCalled();
});

test("a raced replay cannot create a second Play or dispatch", async () => {
    const f = fixture();
    f.tx.playCreationReceipt.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue(f.receipt);
    const result = await f.service.createOrReplay(
        "alice",
        key,
        payload,
        f.prepare,
    );
    expect(result.playCreation.disposition).toBe("replayed");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.tx.play.create).not.toHaveBeenCalled();
    expect(f.tx.playScrobbleDispatch.create).not.toHaveBeenCalled();
});

test("an admitted YouTube Play freezes attribution, receipt and destination from server metadata", async () => {
    const f = fixture();
    const write = { committed: jest.fn(), failed: jest.fn() };
    const result = await f.service.createOrReplay(
        "alice",
        key,
        { ...payload, recommendationGenerationId: "generation-1" },
        f.prepare,
        () => write,
    );
    expect(result.playCreation.disposition).toBe("created");
    expect(f.tx.play.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
            userId: "alice",
            trackYtMusicId: "youtube-1",
            recommendationGenerationId: "generation-1",
        }),
    });
    expect(f.tx.play.update).toHaveBeenCalledWith({
        where: { id: "play-1" },
        data: {
            localAttributionState: "APPLIED",
            attributedExposureId: "exposure-1",
        },
    });
    expect(f.tx.playCreationReceipt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
            userId: "alice",
            clientPlaybackId: key,
            playId: "play-1",
        }),
    });
    expect(f.tx.playScrobbleDispatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
            userId: "alice",
            connectionId: "lastfm-1",
            authEpoch: 3,
            userTokenVersion: 2,
            state: "PENDING",
            metadata: {
                title: "Resolved song",
                artist: "Resolved artist",
                durationSeconds: 180,
            },
        }),
    });
    expect(write.committed).toHaveBeenCalledTimes(1);
    expect(write.failed).not.toHaveBeenCalled();
});

test.each(["vk", "yandex"] as const)(
    "%s snapshots remain private and cannot create an external dispatch",
    async (provider) => {
        const f = fixture();
        const recording = {
            provider,
            id: provider === "vk" ? "-1_2" : "123",
            title: "Private song",
            artists: ["Private artist"],
            duration: 180,
            contentVersion: "unknown" as const,
            preview: false as const,
        };
        await f.service.createOrReplay(
            "alice",
            key,
            { musicSourceRecording: recording },
            f.prepare,
        );
        expect(f.tx.play.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: "alice",
                source: provider === "vk" ? "VK" : "YANDEX",
                musicSourceRecording: recording,
                trackMusicSourceId: "native-1",
            }),
        });
        expect(f.tx.playScrobbleDispatch.create).not.toHaveBeenCalled();
        expect(f.tx.scrobbleConnection.findMany).not.toHaveBeenCalled();
    },
);

test("a failed receipt write cannot be reported as a committed Play", async () => {
    const f = fixture();
    f.tx.playCreationReceipt.create.mockRejectedValue(
        new Error("receipt write failed"),
    );
    const write = { committed: jest.fn(), failed: jest.fn() };
    await expect(
        f.service.createOrReplay("alice", key, payload, f.prepare, () => write),
    ).rejects.toThrow("receipt write failed");
    expect(write.failed).toHaveBeenCalledTimes(1);
    expect(write.committed).not.toHaveBeenCalled();
});

test("legacy engagement stays with its existing adapter; missing plays remain owner-scoped", async () => {
    const f = fixture();
    f.tx.play.findFirst
        .mockResolvedValueOnce({ localAttributionState: "LEGACY" })
        .mockResolvedValueOnce(null);
    expect(
        await f.service.updateEngagement("alice", "legacy-play", engagement),
    ).toBeNull();
    await expect(
        f.service.updateEngagement("alice", "foreign-play", engagement),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.tx.play.updateMany).not.toHaveBeenCalled();
    expect(f.tx.play.findFirst).toHaveBeenLastCalledWith({
        where: { id: "foreign-play", userId: "alice" },
    });
});

test("accepted engagement projects only its frozen exposure; stale updates do not project again", async () => {
    const f = fixture();
    const write = { committed: jest.fn(), failed: jest.fn() };
    expect(
        await f.service.updateEngagement(
            "alice",
            "play-1",
            engagement,
            () => write,
        ),
    ).toEqual({ success: true });
    expect(f.tx.recommendationExposure.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
            where: expect.objectContaining({
                id: "exposure-1",
                userId: "alice",
            }),
            data: expect.objectContaining({
                lastPlayId: "play-1",
                ...engagement,
            }),
        }),
    );
    f.tx.recommendationExposure.updateMany.mockClear();
    f.tx.play.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
        await f.service.updateEngagement("alice", "play-1", engagement),
    ).toEqual({ success: true, stale: true });
    expect(f.tx.recommendationExposure.updateMany).not.toHaveBeenCalled();
    expect(write.committed).toHaveBeenCalledTimes(1);
});

test("engagement transaction failures report failure without a commit observation", async () => {
    const f = fixture();
    f.tx.play.updateMany.mockRejectedValue(new Error("database unavailable"));
    const write = { committed: jest.fn(), failed: jest.fn() };
    await expect(
        f.service.updateEngagement("alice", "play-1", engagement, () => write),
    ).rejects.toThrow("database unavailable");
    expect(write.failed).toHaveBeenCalledTimes(1);
    expect(write.committed).not.toHaveBeenCalled();
});

test.each(["7d", "30d", "365d", "all"] as const)(
    "clearing %s revokes the epoch and tombstones matching receipts and dispatches",
    async (range) => {
        const f = fixture();
        expect(await f.service.clearHistory("alice", range)).toEqual({
            count: 3,
        });
        const where = f.tx.play.deleteMany.mock.calls[0][0].where;
        expect(where.userId).toBe("alice");
        if (range === "all") expect(where.playedAt).toBeUndefined();
        else expect(where.playedAt.lte).toEqual(now);
        expect(f.tx.user.update).toHaveBeenCalledWith({
            where: { id: "alice" },
            data: { playHistoryEpoch: { increment: 1 } },
        });
        expect(f.tx.playCreationReceipt.updateMany).toHaveBeenCalledWith({
            where: { userId: "alice", play: where },
            data: { deletedAt: now, requestHash: null },
        });
        expect(
            f.tx.playScrobbleDispatch.updateMany.mock.calls.map(
                ([input]) => input.data.state,
            ),
        ).toEqual(["CANCELLED", "AMBIGUOUS"]);
    },
);

test("history epoch exhaustion fails before deleting or reauthorizing old keys", async () => {
    const f = fixture();
    f.owner.epoch = 2_147_483_647;
    await expect(f.service.clearHistory("alice", "all")).rejects.toMatchObject({
        status: 503,
    });
    expect(f.tx.play.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
});

test("receipt GC keeps an existing higher rejection floor and scopes its bounded delete to the owner", async () => {
    const f = fixture();
    f.owner.prunedThrough = new Date(now.getTime() - 1000);
    f.tx.playCreationReceipt.findMany.mockResolvedValue([
        {
            clientPlaybackId: "old-one",
            issuedAt: new Date(now.getTime() - 2000),
        },
        {
            clientPlaybackId: "old-two",
            issuedAt: new Date(now.getTime() - 3000),
        },
    ]);
    expect(await f.service.pruneExpiredReceipts("alice", 2)).toBe(2);
    expect(f.tx.user.update).toHaveBeenCalledWith({
        where: { id: "alice" },
        data: { playReceiptPrunedThrough: f.owner.prunedThrough },
    });
    expect(f.tx.playCreationReceipt.deleteMany).toHaveBeenCalledWith({
        where: {
            userId: "alice",
            clientPlaybackId: { in: ["old-one", "old-two"] },
        },
    });
    expect(f.tx.playCreationReceipt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
            take: 2,
            where: {
                userId: "alice",
                expiresAt: { lt: new Date(now.getTime() - 300_000) },
            },
        }),
    );
});

test("empty GC and invalid bounds cannot move the replay floor", async () => {
    const f = fixture();
    expect(await f.service.pruneExpiredReceipts("alice")).toBe(0);
    await expect(f.service.pruneExpiredReceipts("alice", 101)).rejects.toThrow(
        RangeError,
    );
    expect(f.tx.user.update).not.toHaveBeenCalled();
    expect(f.tx.playCreationReceipt.deleteMany).not.toHaveBeenCalled();
});
