jest.mock("../../utils/db", () => ({
    prisma: {
        musicSourceConnection: {
            findMany: jest.fn(),
            upsert: jest.fn(),
            updateMany: jest.fn(),
        },
    },
}));
jest.mock("../../utils/encryption", () => ({
    encrypt: (v: string) => `encrypted:${v}`,
    decrypt: (v: string) => v.replace("encrypted:", ""),
}));
import { prisma } from "../../utils/db";
import {
    listMusicSourceConnections,
    saveMusicSourceConnection,
    loadMusicSourceAdapters,
} from "../musicSources/connections";

const db = prisma as unknown as {
    musicSourceConnection: {
        findMany: jest.Mock;
        upsert: jest.Mock;
        updateMany: jest.Mock;
    };
};
describe("server-owned connections", () => {
    beforeEach(() => jest.clearAllMocks());
    it("never returns a token or ciphertext in status", async () => {
        db.musicSourceConnection.findMany.mockResolvedValue([
            {
                id: "yandex",
                token: "encrypted:secret",
                version: 2,
                enabled: false,
                updatedAt: new Date(0),
            },
        ]);
        const status = await listMusicSourceConnections();
        expect(status).toEqual([
            {
                provider: "yandex",
                configured: true,
                enabled: false,
                version: 2,
                updatedAt: new Date(0),
            },
        ]);
        expect(JSON.stringify(status)).not.toMatch(/secret|encrypted/);
    });
    it("encrypts service credentials and fences prior leases on changes", async () => {
        await saveMusicSourceConnection("vk", {
            token: "own-service-token",
            enabled: false,
        });
        expect(db.musicSourceConnection.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "vk" },
                create: {
                    id: "vk",
                    token: "encrypted:own-service-token",
                    enabled: false,
                },
                update: {
                    token: "encrypted:own-service-token",
                    enabled: false,
                    version: { increment: 1 },
                },
            }),
        );
    });
    it("does not construct adapters for disabled connections", async () => {
        db.musicSourceConnection.findMany.mockResolvedValue([
            { id: "vk", token: "encrypted:secret", version: 2, enabled: false },
        ]);
        expect(await loadMusicSourceAdapters()).toEqual([]);
    });
    it("keeps credentialless configuration fail closed", async () => {
        await expect(
            saveMusicSourceConnection("vk", { enabled: true }),
        ).rejects.toMatchObject({ code: "auth_required" });
    });
});
