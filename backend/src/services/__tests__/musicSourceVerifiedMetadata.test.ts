jest.mock("../../utils/db", () => ({ prisma: { $transaction: jest.fn() } }));

import { prisma } from "../../utils/db";
import { recordVerifiedMusicSourceMetadata } from "../musicSources/verifiedMetadata";
import type { VerifiedMusicSourceRecording } from "../musicSources/types";

const input: VerifiedMusicSourceRecording = {
    provider: "vk",
    providerTrackId: "-12_34",
    connectionVersion: 7,
    observedAt: new Date("2026-10-08T08:00:00Z"),
    recording: {
        provider: "vk",
        id: "-12_34",
        title: "Exact recording",
        artists: ["Artist", "Guest"],
        duration: 180.125,
        contentVersion: "clean",
        preview: false,
        isrc: "USABC2600001",
    },
};
const tx = {
    $queryRaw: jest.fn(),
    trackMusicSource: { upsert: jest.fn(), updateMany: jest.fn() },
};
const transact = prisma.$transaction as jest.Mock;
beforeEach(() => {
    jest.resetAllMocks();
    tx.$queryRaw.mockResolvedValue([{ version: 7 }]);
    tx.trackMusicSource.upsert.mockResolvedValue({ id: "namespace" });
    tx.trackMusicSource.updateMany.mockResolvedValue({ count: 1 });
    transact.mockImplementation(async (operation) => operation(tx));
});

test("writer stores bounded exact provider data and fractional duration without extra claims", async () => {
    const recording = {
        ...input.recording,
        url: "https://fixture.invalid/signed-audio?secret=private",
        token: "private",
        userId: "another-user",
    };
    await recordVerifiedMusicSourceMetadata(
        { ...input, recording },
        new AbortController().signal,
        500,
    );
    expect(tx.trackMusicSource.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.trackMusicSource.updateMany.mock.calls[0][0].data).toEqual({
        verifiedMetadata: input.recording,
        metadataObservedAt: input.observedAt,
        metadataConnectionVersion: 7,
    });
    expect(
        JSON.stringify(tx.trackMusicSource.updateMany.mock.calls),
    ).not.toMatch(/signed-audio|private|another-user/);
});

test.each([
    { id: "-12_35" },
    { provider: "yandex" },
    { preview: true },
    { title: "x".repeat(201) },
    { artists: Array.from({ length: 11 }, () => "Artist") },
    { artists: [""] },
    { duration: 0 },
    { duration: 3600.1 },
    { isrc: "unverified" },
])("invalid exact metadata %j performs no transaction", async (change) => {
    const recording = {
        ...input.recording,
        ...change,
    } as typeof input.recording;
    await expect(
        recordVerifiedMusicSourceMetadata(
            { ...input, recording },
            new AbortController().signal,
            500,
        ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(transact).not.toHaveBeenCalled();
});

test.each([
    { connectionVersion: 0 },
    { connectionVersion: 1.5 },
    { observedAt: new Date("invalid") },
    { providerTrackId: "../../secret" },
])("invalid attestation provenance performs no transaction", async (change) => {
    await expect(
        recordVerifiedMusicSourceMetadata(
            { ...input, ...change },
            new AbortController().signal,
            500,
        ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(transact).not.toHaveBeenCalled();
});

test("disabled or replaced credential generation creates no identity or metadata", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await recordVerifiedMusicSourceMetadata(
        input,
        new AbortController().signal,
        500,
    );
    expect(tx.trackMusicSource.upsert).not.toHaveBeenCalled();
    expect(tx.trackMusicSource.updateMany).not.toHaveBeenCalled();
});

test("provenance is captured before awaiting the credential lock", async () => {
    const value = {
        ...input,
        observedAt: new Date(input.observedAt),
        recording: {
            ...input.recording,
            artists: [...input.recording.artists],
        },
    };
    tx.$queryRaw.mockImplementation(async () => {
        value.provider = "yandex";
        value.providerTrackId = "1234";
        value.connectionVersion = 8;
        value.observedAt.setTime(0);
        value.recording.title = "Changed after lookup";
        value.recording.artists[0] = "Changed artist";
        return [{ version: 7 }];
    });
    await recordVerifiedMusicSourceMetadata(
        value,
        new AbortController().signal,
        500,
    );
    expect(tx.trackMusicSource.upsert.mock.calls[0][0].create).toEqual({
        provider: "vk",
        providerTrackId: "-12_34",
    });
    expect(tx.trackMusicSource.updateMany.mock.calls[0][0].data).toEqual({
        verifiedMetadata: input.recording,
        metadataObservedAt: input.observedAt,
        metadataConnectionVersion: 7,
    });
});

test.each(["before-write", "after-credential-lock"])(
    "owner abort %s performs no namespace write",
    async (phase) => {
        const controller = new AbortController();
        if (phase === "before-write") controller.abort();
        else
            tx.$queryRaw
                .mockResolvedValueOnce([])
                .mockImplementation(async () => {
                    controller.abort();
                    return [{ version: 7 }];
                });
        await expect(
            recordVerifiedMusicSourceMetadata(input, controller.signal, 500),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(tx.trackMusicSource.upsert).not.toHaveBeenCalled();
        expect(tx.trackMusicSource.updateMany).not.toHaveBeenCalled();
        if (phase === "before-write") expect(transact).not.toHaveBeenCalled();
    },
);
