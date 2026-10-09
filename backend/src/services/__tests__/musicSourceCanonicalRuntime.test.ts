import { Readable } from "node:stream";

const mockAdapters = jest.fn();
jest.mock("../musicSources/connections", () => ({
    loadMusicSourceAdapters: (...args: unknown[]) => mockAdapters(...args),
}));
jest.mock("../musicSources/catalog", () => ({
    createMusicSourceCatalog: () => ({}),
}));
jest.mock("../../utils/db", () => ({ prisma: { $transaction: jest.fn() } }));

import { prisma } from "../../utils/db";
import { musicSourceResolver } from "../musicSources/runtime";
import type {
    MusicSource,
    MusicSourceAdapter,
    MusicSourceTrack,
} from "../musicSources/types";

const tx = {
    $queryRaw: jest.fn(),
    trackMusicSource: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
    },
    canonicalRecording: { upsert: jest.fn(), findUnique: jest.fn() },
    trackMapping: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
};
const transact = prisma.$transaction as jest.Mock;

function fixture(provider: MusicSource = "vk") {
    const recording: MusicSourceTrack = {
        provider,
        id: provider === "vk" ? "-001_002" : "0007",
        title: "Confirmed song",
        artists: ["Artist", "Guest"],
        duration: 180.125,
        contentVersion: "clean",
        preview: false,
        isrc: "USABC2600001",
    };
    const source: MusicSourceAdapter = {
        provider,
        version: 7,
        enabled: true,
        search: jest.fn(async () => [recording]),
        lookup: jest.fn(async () => recording),
        open: jest.fn(async () => ({
            status: 206,
            headers: { etag: '"exact"', "content-range": "bytes 0-0/100" },
            data: Readable.from([Buffer.from("a")]),
        })),
    };
    let stored: unknown = null;
    tx.$queryRaw.mockResolvedValue([{ version: 7, id: "namespace" }]);
    tx.trackMusicSource.upsert.mockResolvedValue({ id: "namespace" });
    tx.trackMusicSource.updateMany.mockImplementation(async (query) => {
        stored = {
            provider,
            providerTrackId:
                tx.trackMusicSource.upsert.mock.calls[0][0].create
                    .providerTrackId,
            ...query.data,
        };
        return { count: 1 };
    });
    tx.trackMusicSource.findUnique.mockImplementation(async () => stored);
    tx.trackMapping.findFirst.mockResolvedValue(null);
    tx.trackMapping.create.mockResolvedValue({ id: "mapping" });
    tx.canonicalRecording.upsert.mockResolvedValue({
        id: "canonical",
        canonicalKey: `provider:${provider}:${recording.id}`,
        mergedIntoId: null,
        identitySource: "verified-source",
    });
    mockAdapters.mockResolvedValue([source]);
    return { recording, source };
}

beforeEach(() => {
    jest.resetAllMocks();
    transact.mockImplementation(async (operation) => operation(tx));
    musicSourceResolver.revokeUser("owner");
});
afterEach(() => musicSourceResolver.revokeUser("owner"));

test.each(["vk", "yandex"] as const)(
    "actual exact %s lookup creates stored canonical mapping in the existing metadata transaction",
    async (provider) => {
        const { recording, source } = fixture(provider);
        const lease = await musicSourceResolver.resolve(
            "owner",
            null,
            new AbortController().signal,
            provider,
            recording.id,
        );
        expect(lease).toMatchObject({ provider });
        expect(source.lookup).toHaveBeenCalledWith(
            recording.id,
            expect.any(AbortSignal),
        );
        expect(tx.trackMapping.create).toHaveBeenCalledWith({
            data: {
                trackMusicSourceId: "namespace",
                canonicalRecordingId: "canonical",
                source: "verified-source",
                confidence: 1,
            },
        });
        expect(transact).toHaveBeenCalledTimes(1);
        expect(transact.mock.calls[0][1]).toEqual({
            maxWait: 250,
            timeout: 250,
        });
        expect(tx.canonicalRecording.upsert.mock.calls[0][0].create).toEqual({
            canonicalKey: `provider:${provider}:${recording.id}`,
            title: "Confirmed song",
            artist: "Artist, Guest",
            duration: 180,
            identitySource: "verified-source",
            identityConfidence: 1,
        });
        expect(Object.keys(lease!).sort()).toEqual([
            "expiresAt",
            "leaseId",
            "provider",
            "streamPath",
        ]);
    },
);

test("ordinary search does not become a canonical attestation", async () => {
    const { recording } = fixture();
    expect(
        await musicSourceResolver.resolve(
            "owner",
            recording,
            new AbortController().signal,
        ),
    ).toMatchObject({ provider: "vk" });
    expect(transact).not.toHaveBeenCalled();
    expect(tx.trackMapping.create).not.toHaveBeenCalled();
});

test.each(["preview", "probe-failed", "replaced-id"])(
    "%s cannot create shared canonical facts",
    async (failure) => {
        const { recording, source } = fixture();
        if (failure === "preview")
            source.lookup = jest.fn(async () => ({
                ...recording,
                preview: true,
            }));
        if (failure === "replaced-id")
            source.lookup = jest.fn(async () => ({
                ...recording,
                id: "-001_003",
            }));
        if (failure === "probe-failed")
            source.open = jest.fn(async () => {
                throw Error("private-upstream-details");
            });
        expect(
            await musicSourceResolver.resolve(
                "owner",
                null,
                new AbortController().signal,
                "vk",
                recording.id,
            ),
        ).toBeNull();
        expect(tx.trackMapping.create).not.toHaveBeenCalled();
    },
);

test("superseded observation creates no identity even when its namespace exists", async () => {
    const { recording } = fixture();
    tx.trackMusicSource.updateMany.mockResolvedValue({ count: 0 });
    expect(
        await musicSourceResolver.resolve(
            "owner",
            null,
            new AbortController().signal,
            "vk",
            recording.id,
        ),
    ).toMatchObject({ provider: "vk" });
    expect(tx.trackMusicSource.findUnique).not.toHaveBeenCalled();
    expect(tx.canonicalRecording.upsert).not.toHaveBeenCalled();
    expect(tx.trackMapping.create).not.toHaveBeenCalled();
});

test("cancel before lookup performs no shared transaction and no lease", async () => {
    const { recording } = fixture();
    const owner = new AbortController();
    owner.abort();
    await expect(
        musicSourceResolver.resolve(
            "owner",
            null,
            owner.signal,
            "vk",
            recording.id,
        ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transact).not.toHaveBeenCalled();
    expect(musicSourceResolver.health().leases).toBe(0);
});

test("existing canonical survivor is preserved without replacing its shared features", async () => {
    const { recording } = fixture();
    tx.trackMapping.findFirst.mockResolvedValue({
        id: "mapping",
        canonicalRecording: {
            id: "alias",
            canonicalKey: "provider:vk:-001_002",
            mergedIntoId: "survivor",
            identitySource: "identity-merged",
        },
    });
    tx.canonicalRecording.findUnique.mockResolvedValue({
        id: "survivor",
        canonicalKey: "mbid:known-survivor",
        mergedIntoId: null,
        identitySource: "existing",
    });
    expect(
        await musicSourceResolver.resolve(
            "owner",
            null,
            new AbortController().signal,
            "vk",
            recording.id,
        ),
    ).toMatchObject({ provider: "vk" });
    expect(tx.trackMusicSource.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.canonicalRecording.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "survivor" } }),
    );
    expect(tx.canonicalRecording.upsert).not.toHaveBeenCalled();
    expect(tx.trackMapping.create).not.toHaveBeenCalled();
    expect(tx.trackMapping.update).not.toHaveBeenCalled();
    expect(transact).toHaveBeenCalledTimes(1);
});

test("an optional identity failure retains the probed lease without exposing errors", async () => {
    const { recording } = fixture();
    tx.canonicalRecording.upsert.mockRejectedValue(
        Error("private-database-credential-details"),
    );
    const lease = await musicSourceResolver.resolve(
        "owner",
        null,
        new AbortController().signal,
        "vk",
        recording.id,
    );
    expect(tx.canonicalRecording.upsert).toHaveBeenCalledTimes(1);
    expect(tx.trackMapping.create).not.toHaveBeenCalled();
    expect(lease).toMatchObject({ provider: "vk" });
    expect(JSON.stringify(lease)).not.toContain("private-database");
    expect(musicSourceResolver.health().circuits).toEqual([]);
});

test.each(["after-metadata", "after-namespace-lock", "after-canonical-upsert"])(
    "owner cancellation %s stops mapping and lease publication",
    async (phase) => {
        const { recording } = fixture();
        const owner = new AbortController();
        if (phase === "after-metadata")
            tx.trackMusicSource.updateMany.mockImplementation(async () => {
                owner.abort();
                return { count: 1 };
            });
        else if (phase === "after-namespace-lock")
            tx.$queryRaw.mockImplementation(async (strings) => {
                if (strings.join("").includes('FROM "TrackMusicSource"'))
                    owner.abort();
                return [{ id: "namespace", version: 7 }];
            });
        else
            tx.canonicalRecording.upsert.mockImplementation(async () => {
                owner.abort();
                return {
                    id: "canonical",
                    canonicalKey: "provider:vk:-001_002",
                    mergedIntoId: null,
                    identitySource: "verified-source",
                };
            });
        await expect(
            musicSourceResolver.resolve(
                "owner",
                null,
                owner.signal,
                "vk",
                recording.id,
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(tx.trackMapping.create).not.toHaveBeenCalled();
        expect(musicSourceResolver.health().leases).toBe(0);
        expect(transact).toHaveBeenCalledTimes(1);
    },
);

test("metadata writer keeps the original namespace when lookup input mutates during DB work", async () => {
    const { recording } = fixture();
    tx.$queryRaw.mockImplementation(async () => {
        recording.provider = "yandex";
        recording.id = "9999";
        recording.title = "Mutated private text";
        recording.artists[0] = "Changed";
        return [{ id: "namespace", version: 7 }];
    });
    const lease = await musicSourceResolver.resolve(
        "owner",
        null,
        new AbortController().signal,
        "vk",
        "-001_002",
    );
    expect(lease).toMatchObject({ provider: "vk" });
    expect(tx.trackMapping.create).toHaveBeenCalledTimes(1);
    expect(tx.canonicalRecording.upsert.mock.calls[0][0].create).toMatchObject({
        canonicalKey: "provider:vk:-001_002",
        title: "Confirmed song",
        artist: "Artist, Guest",
    });
});

test("cancellation while following an alias cannot start the next survivor lookup", async () => {
    const { recording } = fixture();
    const owner = new AbortController();
    tx.trackMapping.findFirst.mockResolvedValue({
        id: "mapping",
        canonicalRecording: {
            id: "alias-1",
            canonicalKey: "old-1",
            mergedIntoId: "alias-2",
            identitySource: "identity-merged",
        },
    });
    tx.canonicalRecording.findUnique
        .mockImplementationOnce(async () => {
            owner.abort();
            return {
                id: "alias-2",
                canonicalKey: "old-2",
                mergedIntoId: "survivor",
                identitySource: "identity-merged",
            };
        })
        .mockResolvedValue({
            id: "survivor",
            canonicalKey: "live",
            mergedIntoId: null,
            identitySource: "confirmed",
        });
    await expect(
        musicSourceResolver.resolve(
            "owner",
            null,
            owner.signal,
            "vk",
            recording.id,
        ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(tx.canonicalRecording.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.trackMapping.create).not.toHaveBeenCalled();
    expect(musicSourceResolver.health().leases).toBe(0);
});
