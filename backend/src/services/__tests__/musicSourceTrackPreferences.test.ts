const mockPrisma = {
    trackMusicSource: { findUnique: jest.fn() },
    trackYtMusic: { findUnique: jest.fn() },
    trackTidal: { findUnique: jest.fn() },
    likedRemoteTrack: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    dislikedEntity: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    remotePreferenceIntent: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
};
jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
import {
    applyRemoteTrackPreferenceSignal,
    cancelRemoteTrackPreferenceIntent,
    loadRemoteTrackPreference,
    parseRemoteTrackPreferenceReference,
    reserveRemoteTrackPreferenceIntent,
    type RemoteTrackPreferenceReference,
    type RemoteTrackLikeTarget,
} from "../libraryTrackPreferences";
import { MusicSourceError } from "../musicSources/types";

const NOW = new Date("2026-10-08T08:00:00Z");
function directReference(provider: "vk" | "yandex", externalId: string) {
    return {
        provider,
        externalId,
    } as unknown as RemoteTrackPreferenceReference;
}
function namespace(
    provider: "vk" | "yandex",
    providerTrackId: string,
    id = "direct-row",
) {
    return {
        id,
        provider,
        providerTrackId,
        verifiedMetadata: {
            provider,
            id: providerTrackId,
            title: "Confirmed",
            artists: ["Artist"],
            duration: 180,
            contentVersion: "clean",
            preview: false,
        },
        metadataObservedAt: NOW,
        metadataConnectionVersion: 7,
    };
}
function installStore(provider: "vk" | "yandex", externalId: string) {
    const row = namespace(provider, externalId);
    const likes = new Map<string, Date>();
    const dislikes = new Map<string, Date>();
    const intents = new Map<string, string>();
    const key = (owner: string, id: string) => `${owner}|${id}`;
    mockPrisma.trackMusicSource.findUnique.mockImplementation(
        async ({ where }: any) =>
            where.id === row.id ||
            (where.provider_providerTrackId?.provider === provider &&
                where.provider_providerTrackId?.providerTrackId === externalId)
                ? row
                : null,
    );
    mockPrisma.trackYtMusic.findUnique.mockResolvedValue(null);
    mockPrisma.trackTidal.findUnique.mockResolvedValue(null);
    mockPrisma.likedRemoteTrack.findUnique.mockImplementation(
        async ({ where }: any) => {
            const target = where.userId_trackMusicSourceId;
            const likedAt =
                target &&
                likes.get(key(target.userId, target.trackMusicSourceId));
            return likedAt ? { likedAt } : null;
        },
    );
    mockPrisma.likedRemoteTrack.upsert.mockImplementation(
        async ({ create, update }: any) => {
            likes.set(
                key(create.userId, create.trackMusicSourceId),
                update.likedAt,
            );
            return {};
        },
    );
    mockPrisma.likedRemoteTrack.deleteMany.mockImplementation(
        async ({ where }: any) => ({
            count: Number(
                likes.delete(key(where.userId, where.trackMusicSourceId)),
            ),
        }),
    );
    mockPrisma.dislikedEntity.findUnique.mockImplementation(
        async ({ where }: any) => {
            const target = where.userId_entityType_entityId;
            const dislikedAt = dislikes.get(
                key(target.userId, target.entityId),
            );
            return dislikedAt ? { dislikedAt } : null;
        },
    );
    mockPrisma.dislikedEntity.upsert.mockImplementation(
        async ({ create, update }: any) => {
            dislikes.set(
                key(create.userId, create.entityId),
                update.dislikedAt,
            );
            return {};
        },
    );
    mockPrisma.dislikedEntity.deleteMany.mockImplementation(
        async ({ where }: any) => ({
            count: Number(dislikes.delete(key(where.userId, where.entityId))),
        }),
    );
    mockPrisma.remotePreferenceIntent.upsert.mockImplementation(
        async ({ create }: any) => {
            intents.set(key(create.userId, create.remoteTrackId), create.token);
            return {};
        },
    );
    mockPrisma.remotePreferenceIntent.updateMany.mockImplementation(
        async ({ where }: any) => ({
            count: Number(
                intents.get(key(where.userId, where.remoteTrackId)) ===
                    where.token,
            ),
        }),
    );
    mockPrisma.remotePreferenceIntent.deleteMany.mockImplementation(
        async ({ where }: any) => {
            const target = key(where.userId, where.remoteTrackId);
            return {
                count:
                    intents.get(target) === where.token
                        ? Number(intents.delete(target))
                        : 0,
            };
        },
    );
    mockPrisma.$transaction.mockImplementation(async (operation: any) =>
        operation(mockPrisma),
    );
    return { row, likes, dislikes, intents, key };
}
async function apply(
    owner: string,
    reference: RemoteTrackPreferenceReference,
    signal: "thumbs_up" | "thumbs_down" | "clear",
    target?: RemoteTrackLikeTarget,
    token?: string,
) {
    const intentToken =
        token ??
        (await reserveRemoteTrackPreferenceIntent({
            userId: owner,
            reference,
            requestedAt: NOW,
        }));
    return applyRemoteTrackPreferenceSignal({
        userId: owner,
        reference,
        signal,
        now: NOW,
        intentToken,
        likedTarget: target,
    });
}

describe("exact direct owner preferences", () => {
    beforeEach(() => jest.resetAllMocks());
    it.each([
        ["vk", "-12_34"],
        ["vk", "9".repeat(20) + "_" + "8".repeat(20)],
        ["yandex", "123"],
        ["yandex", "00123"],
    ])("parses the exact %s namespace %s", (provider, externalId) => {
        expect(
            parseRemoteTrackPreferenceReference(`${provider}:${externalId}`),
        ).toEqual({ provider, externalId });
    });
    it.each([
        "vk:1",
        "vk:1_2_3",
        "vk:1_2 ",
        "vk: 1_2",
        `vk:${"1".repeat(21)}_2`,
        "yandex:-1",
        "yandex:1.0",
        "yandex:1 ",
        "audius:abc",
        "youtube:abc",
        "yt:a/b",
    ])("rejects unsupported/malformed reference %s", (id) => {
        expect(parseRemoteTrackPreferenceReference(id)).toBeNull();
    });
    it.each([
        ["vk", "-12_34"],
        ["yandex", "123"],
    ] as const)(
        "stores and reads %s like in its own namespace",
        async (provider, externalId) => {
            const store = installStore(provider, externalId);
            const reference = directReference(provider, externalId);
            const target = {
                provider,
                trackMusicSourceId: store.row.id,
            } as unknown as RemoteTrackLikeTarget;
            const result = await apply(
                "owner-a",
                reference,
                "thumbs_up",
                target,
            );
            expect(result.signal).toBe("thumbs_up");
            expect(store.likes.get(store.key("owner-a", store.row.id))).toEqual(
                NOW,
            );
            expect(
                (await loadRemoteTrackPreference("owner-a", reference)).signal,
            ).toBe("thumbs_up");
            expect(
                (await loadRemoteTrackPreference("owner-b", reference)).signal,
            ).toBe("clear");
            expect(mockPrisma.trackYtMusic.findUnique).not.toHaveBeenCalled();
            expect(mockPrisma.trackTidal.findUnique).not.toHaveBeenCalled();
        },
    );
    it.each([
        ["vk", "-12_34"],
        ["yandex", "123"],
    ] as const)(
        "orders %s dislike/clear before an older slow like",
        async (provider, externalId) => {
            const store = installStore(provider, externalId);
            const reference = directReference(provider, externalId);
            const oldToken = await reserveRemoteTrackPreferenceIntent({
                userId: "owner-a",
                reference,
                requestedAt: NOW,
            });
            expect(
                (await apply("owner-a", reference, "thumbs_down")).signal,
            ).toBe("thumbs_down");
            expect(
                (
                    await apply(
                        "owner-a",
                        reference,
                        "thumbs_up",
                        undefined,
                        oldToken,
                    )
                ).signal,
            ).toBe("thumbs_down");
            expect(
                store.dislikes.has(
                    store.key("owner-a", `${provider}:${externalId}`),
                ),
            ).toBe(true);
            expect(mockPrisma.likedRemoteTrack.upsert).not.toHaveBeenCalled();
            const clearToken = await reserveRemoteTrackPreferenceIntent({
                userId: "owner-a",
                reference,
                requestedAt: NOW,
            });
            expect(
                (
                    await apply(
                        "owner-a",
                        reference,
                        "clear",
                        undefined,
                        clearToken,
                    )
                ).signal,
            ).toBe("clear");
            expect(
                (
                    await apply(
                        "owner-a",
                        reference,
                        "thumbs_up",
                        undefined,
                        oldToken,
                    )
                ).signal,
            ).toBe("clear");
            await cancelRemoteTrackPreferenceIntent({
                userId: "owner-a",
                reference,
                intentToken: oldToken,
            });
            expect(
                store.intents.get(
                    store.key("owner-a", `${provider}:${externalId}`),
                ),
            ).toBe(clearToken);
        },
    );
    it("does not let another owner use the same reserved token", async () => {
        const store = installStore("vk", "-12_34");
        const reference = directReference("vk", "-12_34");
        const token = await reserveRemoteTrackPreferenceIntent({
            userId: "owner-a",
            reference,
            requestedAt: NOW,
        });
        expect(
            (await apply("owner-b", reference, "thumbs_down", undefined, token))
                .signal,
        ).toBe("clear");
        expect(store.dislikes.size).toBe(0);
    });
    it.each(["missing", "unattested", "wrong-provider", "wrong-id", "preview"])(
        "rejects %s direct like without constructing client facts",
        async (scenario) => {
            const store = installStore("vk", "-12_34");
            if (scenario === "missing")
                mockPrisma.trackMusicSource.findUnique.mockResolvedValue(null);
            if (scenario === "unattested")
                store.row.verifiedMetadata = null as any;
            if (scenario === "wrong-provider") store.row.provider = "yandex";
            if (scenario === "wrong-id") store.row.providerTrackId = "-12_99";
            if (scenario === "preview")
                store.row.verifiedMetadata.preview = true;
            const reference = directReference("vk", "-12_34");
            const target = {
                provider: "vk",
                trackMusicSourceId: store.row.id,
            } as unknown as RemoteTrackLikeTarget;
            await expect(
                apply("owner-a", reference, "thumbs_up", target),
            ).rejects.toBeInstanceOf(MusicSourceError);
            expect(mockPrisma.likedRemoteTrack.upsert).not.toHaveBeenCalled();
        },
    );
    it("retains exact dislike and permits clear after a namespace disappears", async () => {
        const store = installStore("yandex", "123");
        mockPrisma.trackMusicSource.findUnique.mockResolvedValue(null);
        const reference = directReference("yandex", "123");
        expect((await apply("owner-a", reference, "thumbs_down")).signal).toBe(
            "thumbs_down",
        );
        expect(
            (await loadRemoteTrackPreference("owner-a", reference)).signal,
        ).toBe("thumbs_down");
        expect((await apply("owner-a", reference, "clear")).signal).toBe(
            "clear",
        );
        expect(store.dislikes.size).toBe(0);
        expect(mockPrisma.likedRemoteTrack.upsert).not.toHaveBeenCalled();
    });
});
