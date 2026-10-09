const mockNativeDowns = jest.fn();
const mockNativeNamespaces = jest.fn();
const mockNativeMappings = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        dislikedEntity: { findMany: mockNativeDowns },
        trackMusicSource: { findMany: mockNativeNamespaces },
    },
}));
jest.mock("../canonicalIdentity", () => ({
    findMappedCanonicalCandidates: mockNativeMappings,
}));

import {
    loadDislikedNativeRecordingIds,
    loadSuppressedNativeArtistCredits,
    loadVerifiedNativeCandidates,
    nativeArtistCreditKey,
} from "../nativeSourceAdmission";

const now = new Date("2026-10-08T12:00:00Z"),
    day = 86_400_000;
function namespace(
    provider: "vk" | "yandex",
    id: string,
    artists = ["Artist", "Guest"],
) {
    return {
        provider,
        providerTrackId: id,
        verifiedMetadata: {
            provider,
            id,
            title: `Song ${id}`,
            artists,
            duration: 180,
            contentVersion: "unknown",
            preview: false,
        },
        metadataObservedAt: now as Date | null,
        metadataConnectionVersion: 7 as number | null,
    };
}
function dislike(owner: string, entityId: string, age = 1, index = 0) {
    return {
        id: `down-${index}`,
        userId: owner,
        entityId,
        entityType: "track",
        dislikedAt: new Date(now.getTime() - age * day),
    };
}
let downs: ReturnType<typeof dislike>[],
    namespaces: ReturnType<typeof namespace>[];
beforeEach(() => {
    jest.clearAllMocks();
    downs = [];
    namespaces = [];
    mockNativeDowns.mockImplementation(async (query) => {
        const w = query.where;
        const rows = downs.filter(
            (row) =>
                row.userId === w.userId &&
                row.entityType === w.entityType &&
                (!w.entityId.in || w.entityId.in.includes(row.entityId)) &&
                (!w.entityId.startsWith ||
                    row.entityId.startsWith(w.entityId.startsWith)) &&
                (!w.dislikedAt?.gte || row.dislikedAt >= w.dislikedAt.gte) &&
                (!w.dislikedAt?.lte || row.dislikedAt <= w.dislikedAt.lte),
        );
        const offset = query.cursor
            ? rows.findIndex((row) => row.id === query.cursor.id) + query.skip
            : 0;
        return rows.slice(offset, offset + query.take);
    });
    mockNativeNamespaces.mockImplementation(async (query) =>
        namespaces
            .filter((ns) =>
                query.where.OR.some(
                    (w: any) =>
                        ns.provider === w.provider &&
                        w.providerTrackId.in.includes(ns.providerTrackId),
                ),
            )
            .slice(0, query.take),
    );
    mockNativeMappings.mockImplementation(async (candidates) =>
        candidates.map(() => null),
    );
});
describe("owned exact native admission before radio quotas", () => {
    it("blocks an exact active native dislike without canonical or stored metadata", async () => {
        downs = [
            dislike("alice", "yandex:0007", 100),
            dislike("bob", "yandex:7"),
            dislike("alice", "yandex:7", -1),
        ];
        expect([
            ...(await loadDislikedNativeRecordingIds(
                "alice",
                ["yandex:0007", "yandex:7", "yt:00000000007", "bad"],
                now,
            )),
        ]).toEqual(["yandex:0007"]);
        expect(mockNativeNamespaces).not.toHaveBeenCalled();
        expect(mockNativeMappings).not.toHaveBeenCalled();
        expect(mockNativeDowns.mock.calls[0][0].where).toMatchObject({
            userId: "alice",
            entityType: "track",
            entityId: { in: ["yandex:0007", "yandex:7"] },
            dislikedAt: { lte: now },
        });
    });
    it("needs two distinct owned current dislikes and leaves a different owner alone", async () => {
        downs = [
            dislike("alice", "vk:-1_1"),
            dislike("alice", "vk:-1_2", 2, 1),
            dislike("bob", "vk:-1_3", 1, 2),
        ];
        namespaces = [
            namespace("vk", "-1_1"),
            namespace("vk", "-1_2"),
            namespace("vk", "-1_3"),
        ];
        expect([
            ...(await loadSuppressedNativeArtistCredits("alice", now)),
        ]).toEqual([JSON.stringify(["vk", ["artist", "guest"]])]);
        expect([
            ...(await loadSuppressedNativeArtistCredits("bob", now)),
        ]).toEqual([]);
    });
    it("does not combine providers, guest-only or reversed whole credits", async () => {
        downs = [
            dislike("alice", "vk:-1_1"),
            dislike("alice", "yandex:7", 1, 1),
            dislike("alice", "vk:-1_2", 1, 2),
            dislike("alice", "vk:-1_3", 1, 3),
        ];
        namespaces = [
            namespace("vk", "-1_1"),
            namespace("yandex", "7"),
            namespace("vk", "-1_2", ["Guest", "Artist"]),
            namespace("vk", "-1_3", ["Guest"]),
        ];
        expect([
            ...(await loadSuppressedNativeArtistCredits("alice", now)),
        ]).toEqual([]);
    });
    it("deduplicates confirmed same-recording canonical aliases before the threshold", async () => {
        downs = [
            dislike("alice", "yandex:0007"),
            dislike("alice", "yandex:7", 1, 1),
        ];
        namespaces = [namespace("yandex", "0007"), namespace("yandex", "7")];
        mockNativeMappings.mockImplementation(async (candidates) =>
            candidates.map(() => ({ id: "same", canonicalKey: "same-key" })),
        );
        expect([
            ...(await loadSuppressedNativeArtistCredits("alice", now)),
        ]).toEqual([]);
        mockNativeMappings.mockImplementation(async (candidates) =>
            candidates.map((_: unknown, i: number) => ({
                id: `known-${i}`,
                canonicalKey: `known-${i}`,
            })),
        );
        expect([
            ...(await loadSuppressedNativeArtistCredits("alice", now)),
        ]).toEqual([JSON.stringify(["yandex", ["artist", "guest"]])]);
    });
    it("ignores expired, future and no longer active downs", async () => {
        namespaces = [namespace("vk", "-1_1"), namespace("vk", "-1_2")];
        downs = [
            dislike("alice", "vk:-1_1"),
            dislike("alice", "vk:-1_2", 31, 1),
            dislike("alice", "vk:-1_2", -1, 2),
        ];
        expect([
            ...(await loadSuppressedNativeArtistCredits("alice", now)),
        ]).toEqual([]);
        downs = [dislike("alice", "vk:-1_1")];
        expect([
            ...(await loadSuppressedNativeArtistCredits("alice", now)),
        ]).toEqual([]);
    });
    it("rejects incomplete, preview and inconsistent stored facts, without private activity fallback", async () => {
        downs = [
            dislike("alice", "vk:-1_1"),
            dislike("alice", "vk:-1_2", 1, 1),
        ];
        const first = namespace("vk", "-1_1"),
            second = namespace("vk", "-1_2");
        namespaces = [first, second];
        for (const bad of [
            { ...second, metadataObservedAt: null },
            { ...second, metadataConnectionVersion: null },
            {
                ...second,
                verifiedMetadata: { ...second.verifiedMetadata, preview: true },
            },
            {
                ...second,
                verifiedMetadata: { ...second.verifiedMetadata, id: "-1_3" },
            },
        ]) {
            namespaces = [first, bad];
            expect([
                ...(await loadSuppressedNativeArtistCredits("alice", now)),
            ]).toEqual([]);
        }
        expect(
            mockNativeNamespaces.mock.calls.every(([q]) => !q.select.plays),
        ).toBe(true);
    });
    it("loads only exact confirmed namespaces for queued exclusions preserving zeroes and source", async () => {
        namespaces = [
            namespace("yandex", "0007"),
            namespace("yandex", "7"),
            namespace("vk", "-001_002"),
        ];
        expect(
            (
                await loadVerifiedNativeCandidates([
                    "yandex:0007",
                    "vk:-001_002",
                    "yandex:0007",
                    "bad",
                ])
            ).map((c) => c.id),
        ).toEqual(["yandex:0007", "vk:-001_002"]);
        expect(mockNativeMappings).not.toHaveBeenCalled();
    });
    it("keeps whole ordered normalized credit boundaries instead of ambiguous joined names", () => {
        expect(
            nativeArtistCreditKey(
                namespace("vk", "-1_1", [" A, B "]).verifiedMetadata,
            ),
        ).not.toBe(
            nativeArtistCreditKey(
                namespace("vk", "-1_1", ["A", "B"]).verifiedMetadata,
            ),
        );
        expect(
            nativeArtistCreditKey(
                namespace("vk", "-1_1", ["Ａ", " Guest "]).verifiedMetadata,
            ),
        ).toBe(JSON.stringify(["vk", ["a", "guest"]]));
        expect(
            nativeArtistCreditKey(
                namespace("vk", "-1_1", ["Unknown Artist"]).verifiedMetadata,
            ),
        ).toBeNull();
    });
    it("checks cancellation before any DB read and after the held namespace read", async () => {
        const check = jest.fn(() => {
            throw new Error("cancelled");
        });
        await expect(
            loadSuppressedNativeArtistCredits("alice", now, check),
        ).rejects.toThrow("cancelled");
        expect(mockNativeDowns).not.toHaveBeenCalled();
        let cancelled = false;
        namespaces = [namespace("vk", "-1_1")];
        mockNativeNamespaces.mockImplementation(async () => {
            cancelled = true;
            return namespaces;
        });
        await expect(
            loadVerifiedNativeCandidates(["vk:-1_1"], () => {
                if (cancelled) throw new Error("late");
            }),
        ).rejects.toThrow("late");
        expect(mockNativeMappings).not.toHaveBeenCalled();
    });
    it("scans bounded active pages so invalid stored records do not consume the artist threshold", async () => {
        downs = Array.from({ length: 102 }, (_, i) =>
            dislike("alice", `vk:-1_${i + 1}`, 1, i),
        );
        namespaces = [namespace("vk", "-1_101"), namespace("vk", "-1_102")];
        expect([
            ...(await loadSuppressedNativeArtistCredits("alice", now)),
        ]).toEqual([JSON.stringify(["vk", ["artist", "guest"]])]);
        expect(mockNativeDowns.mock.calls.every(([q]) => q.take === 100)).toBe(
            true,
        );
        expect(mockNativeDowns.mock.calls.length).toBeLessThanOrEqual(20);
    });
});
