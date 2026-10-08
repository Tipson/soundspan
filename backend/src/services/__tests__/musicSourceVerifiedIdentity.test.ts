jest.mock("../../utils/db", () => ({ prisma: { $transaction: jest.fn() } }));

import { prisma } from "../../utils/db";
import { performance } from "node:perf_hooks";
import { readVerifiedMusicSourceRecording } from "../musicSources/verifiedMetadata";
import { resolveVerifiedMusicSourceIdentity } from "../musicSources/verifiedIdentity";

const recording = {
    provider: "vk",
    id: "-12_34",
    title: "Server song",
    artists: ["Artist", "Guest"],
    duration: 180.125,
    contentVersion: "clean",
    preview: false,
    isrc: "USABC2600001",
};
const namespace = () => ({
    id: "namespace",
    provider: "vk",
    providerTrackId: "-12_34",
    verifiedMetadata: { ...recording, artists: [...recording.artists] },
    metadataObservedAt: new Date("2026-10-08T08:00:00Z"),
    metadataConnectionVersion: 7,
});
const canonical = {
    id: "canonical",
    canonicalKey: "provider:vk:-12_34",
    mergedIntoId: null,
    identitySource: "verified-source",
};
const tx = {
    $queryRaw: jest.fn(),
    trackMusicSource: { findUnique: jest.fn() },
    canonicalRecording: { upsert: jest.fn(), findUnique: jest.fn() },
    trackMapping: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
};
const transact = prisma.$transaction as jest.Mock;
beforeEach(() => {
    jest.resetAllMocks();
    tx.$queryRaw.mockResolvedValue([{ id: "namespace" }]);
    tx.trackMusicSource.findUnique.mockResolvedValue(namespace());
    tx.trackMapping.findFirst.mockResolvedValue(null);
    tx.canonicalRecording.upsert.mockResolvedValue(canonical);
    tx.trackMapping.create.mockResolvedValue({ id: "mapping" });
    transact.mockImplementation(async (operation) => operation(tx));
});

test("stored verified facts are parsed independently of mutable caller metadata", () => {
    const input = namespace();
    const parsed = readVerifiedMusicSourceRecording(input);
    expect(parsed).toEqual(recording);
    input.verifiedMetadata.artists[0] = "Private artist";
    expect(parsed?.artists).toEqual(["Artist", "Guest"]);
});

test.each([
    { verifiedMetadata: null },
    { metadataObservedAt: null },
    { metadataObservedAt: new Date("invalid") },
    { metadataConnectionVersion: 0 },
    { metadataConnectionVersion: 1.5 },
    { provider: "library" },
    { providerTrackId: "../other" },
    { verifiedMetadata: { ...recording, id: 1234 } },
    { verifiedMetadata: { ...recording, artists: ["x".repeat(101)] } },
    { verifiedMetadata: { ...recording, artists: [" "] } },
    { verifiedMetadata: { ...recording, title: "x".repeat(201) } },
    { verifiedMetadata: { ...recording, id: "-12_35" } },
    { verifiedMetadata: { ...recording, preview: true } },
])("invalid or incomplete attestation %j is not a canonical fact", (change) => {
    expect(
        readVerifiedMusicSourceRecording({ ...namespace(), ...change }),
    ).toBeNull();
});

test("exact namespace creates a direct mapping without publishing weak shared ISRC identity", async () => {
    await expect(
        resolveVerifiedMusicSourceIdentity(
            "vk",
            "-12_34",
            new AbortController().signal,
        ),
    ).resolves.toEqual({
        id: "canonical",
        canonicalKey: canonical.canonicalKey,
    });
    expect(tx.canonicalRecording.upsert.mock.calls[0][0].create).toEqual({
        canonicalKey: "provider:vk:-12_34",
        title: "Server song",
        artist: "Artist, Guest",
        duration: 180,
        identitySource: "verified-source",
        identityConfidence: 1,
    });
    expect(tx.canonicalRecording.upsert.mock.calls[0][0].update).toEqual({});
    expect(tx.trackMapping.create.mock.calls[0][0].data).toEqual({
        trackMusicSourceId: "namespace",
        canonicalRecordingId: "canonical",
        source: "verified-source",
        confidence: 1,
    });
});

test.each(["missing-row", "unattested"])(
    "%s creates no shared rows",
    async (reason) => {
        if (reason === "missing-row")
            tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        else
            tx.trackMusicSource.findUnique.mockResolvedValue({
                ...namespace(),
                verifiedMetadata: null,
            });
        await expect(
            resolveVerifiedMusicSourceIdentity(
                "vk",
                "-12_34",
                new AbortController().signal,
            ),
        ).resolves.toBeNull();
        expect(tx.canonicalRecording.upsert).not.toHaveBeenCalled();
        expect(tx.trackMapping.create).not.toHaveBeenCalled();
    },
);

test("existing exact mapping follows its survivor and preserves shared features", async () => {
    tx.trackMapping.findFirst.mockResolvedValue({
        id: "mapping",
        canonicalRecording: {
            ...canonical,
            mergedIntoId: "survivor",
            identitySource: "identity-merged",
        },
    });
    tx.canonicalRecording.findUnique.mockResolvedValue({
        ...canonical,
        id: "survivor",
        canonicalKey: "mbid:survivor",
    });
    await expect(
        resolveVerifiedMusicSourceIdentity(
            "vk",
            "-12_34",
            new AbortController().signal,
        ),
    ).resolves.toEqual({ id: "survivor", canonicalKey: "mbid:survivor" });
    expect(tx.canonicalRecording.upsert).not.toHaveBeenCalled();
    expect(tx.trackMapping.create).not.toHaveBeenCalled();
    expect(tx.trackMapping.update).not.toHaveBeenCalled();
});

test("mapping with a deleted canonical target is repaired from server facts", async () => {
    tx.trackMapping.findFirst.mockResolvedValue({
        id: "mapping",
        canonicalRecording: null,
    });
    await resolveVerifiedMusicSourceIdentity(
        "vk",
        "-12_34",
        new AbortController().signal,
    );
    expect(tx.trackMapping.update).toHaveBeenCalledWith({
        where: { id: "mapping" },
        data: { canonicalRecordingId: "canonical" },
    });
    expect(tx.trackMapping.create).not.toHaveBeenCalled();
});

test.each(["before-work", "after-lock", "after-upsert"])(
    "cancelled %s cannot return a mapped identity",
    async (phase) => {
        const controller = new AbortController();
        if (phase === "before-work") controller.abort();
        else if (phase === "after-lock")
            tx.$queryRaw
                .mockResolvedValueOnce([])
                .mockImplementationOnce(async () => {
                    controller.abort();
                    return [{ id: "namespace" }];
                });
        else
            tx.canonicalRecording.upsert.mockImplementation(async () => {
                controller.abort();
                return canonical;
            });
        await expect(
            resolveVerifiedMusicSourceIdentity(
                "vk",
                "-12_34",
                controller.signal,
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(tx.trackMapping.create).not.toHaveBeenCalled();
        if (phase === "before-work") expect(transact).not.toHaveBeenCalled();
    },
);

test.each([
    ["library", "local"],
    ["vk", "../other"],
    ["yandex", "-12_34"],
])("invalid namespace %s:%s performs no SQL", async (provider, id) => {
    await expect(
        resolveVerifiedMusicSourceIdentity(
            provider as "vk",
            id,
            new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(transact).not.toHaveBeenCalled();
});

test("a late serialization retry releases SQL locks within its remaining execution budget", async () => {
    let elapsed = 0;
    const clock = jest
        .spyOn(performance, "now")
        .mockImplementation(() => elapsed);
    transact.mockImplementationOnce(async () => {
        elapsed = 4_500;
        throw { code: "P2034" };
    });
    try {
        await resolveVerifiedMusicSourceIdentity(
            "vk",
            "-12_34",
            new AbortController().signal,
        );
        const executionBudget = transact.mock.calls[1][1].timeout;
        const configuredStatementLimit = Number(tx.$queryRaw.mock.calls[0][1]);
        expect(configuredStatementLimit).toBeLessThan(executionBudget);
        expect(configuredStatementLimit).toBeGreaterThan(0);
    } finally {
        clock.mockRestore();
    }
});
