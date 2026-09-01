export {};

describe("split runtime database bootstrap", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
        jest.unmock("@prisma/client");
        jest.unmock("@prisma/adapter-pg");
    });

    it("resolves POSTGRES components before the Prisma singleton is created", async () => {
        process.env = {
            ...originalEnv,
            DATABASE_URL: "",
            POSTGRES_HOST: "postgres",
            POSTGRES_PORT: "5432",
            POSTGRES_USER: "soundspan",
            POSTGRES_PASSWORD: "password with / reserved?characters",
            POSTGRES_DB: "soundspan",
            REDIS_URL: "redis://redis:6379",
            SESSION_SECRET: "12345678901234567890123456789012",
            JWT_SECRET: "",
            SETTINGS_ENCRYPTION_KEY: "23456789012345678901234567890123",
            INTERNAL_API_SECRET: "34567890123456789012345678901234",
            MUSIC_PATH: "/music",
            LOCAL_LOGIN_ENABLED: "true",
            OIDC_ENABLED: "false",
            OIDC_MANAGE_ROLES: "false",
        };

        const prismaClientCtor = jest.fn().mockImplementation(() => ({}));
        const prismaPgCtor = jest
            .fn()
            .mockImplementation((config: unknown) => ({ config }));

        jest.doMock("@prisma/client", () => ({
            PrismaClient: prismaClientCtor,
            Prisma: {},
        }));
        jest.doMock("@prisma/adapter-pg", () => ({ PrismaPg: prismaPgCtor }));

        await import("../config");
        await import("../utils/db");

        expect(prismaPgCtor).toHaveBeenCalledTimes(1);
        expect(prismaPgCtor.mock.calls[0][0].connectionString).toBe(
            "postgresql://soundspan:password%20with%20%2F%20reserved%3Fcharacters@postgres:5432/soundspan",
        );
    });
});
