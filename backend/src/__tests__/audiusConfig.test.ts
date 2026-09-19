jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../utils/logger", () => ({
    logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock("../utils/encryption", () => ({ validateEncryptionKey: jest.fn() }));
jest.mock("../utils/configValidator", () => ({
    validateMusicConfig: jest.fn(),
}));

describe("Audius config opt-in", () => {
    const previous = process.env;
    afterEach(() => {
        process.env = previous;
        jest.restoreAllMocks();
    });

    function configure(value?: string) {
        jest.resetModules();
        process.env = {
            DATABASE_URL: "postgresql://fixture/soundspan",
            REDIS_URL: "redis://127.0.0.1:6379",
            SESSION_SECRET: "session-fixture-that-is-long-enough-123",
            SETTINGS_ENCRYPTION_KEY:
                "encryption-fixture-that-is-long-enough-123",
            INTERNAL_API_SECRET: "internal-fixture-that-is-long-enough-123",
            MUSIC_PATH: "/music",
            NODE_ENV: "test",
            ...(value === undefined ? {} : { FEATURE_AUDIUS: value }),
        };
        return import("../config");
    }

    it("is disabled by default and only explicitly enabled", async () => {
        expect((await configure()).config.features.audius).toBe(false);
        expect((await configure("false")).config.features.audius).toBe(false);
        expect((await configure("true")).config.features.audius).toBe(true);
    });

    it("rejects invalid opt-in values at startup", async () => {
        jest.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("exit");
        });
        await expect(configure("enabled")).rejects.toThrow("exit");
    });
});
