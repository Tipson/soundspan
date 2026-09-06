import { createPlaybackTestAccount } from "../playbackTestAccount";

describe("dedicated playback test account", () => {
    const credentials = {
        username: "soundspan-test-playback",
        password: "a-long-test-only-password",
    };
    const create = jest.fn();
    const hashPassword = jest.fn(async () => "hashed-password");
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("creates a separate non-admin test identity with private defaults", async () => {
        create.mockResolvedValue({
            id: "test-id",
            username: credentials.username,
        });
        await expect(
            createPlaybackTestAccount(credentials, { create, hashPassword }),
        ).resolves.toEqual({ id: "test-id", username: credentials.username });
        expect(create).toHaveBeenCalledWith({
            username: credentials.username,
            passwordHash: "hashed-password",
            role: "user",
            isTestAccount: true,
            onboardingComplete: false,
        });
    });

    it.each([
        { username: "dartum", password: credentials.password },
        { username: "soundspan-test-", password: credentials.password },
        { username: credentials.username, password: "123456" },
        { username: credentials.username, password: "я".repeat(40) },
    ])(
        "rejects unsafe credentials before persistence or hashing",
        async (input) => {
            await expect(
                createPlaybackTestAccount(input, { create, hashPassword }),
            ).rejects.toThrow();
            expect(create).not.toHaveBeenCalled();
            expect(hashPassword).not.toHaveBeenCalled();
        },
    );

    it("does not replace or reset an existing account on a name collision", async () => {
        const collision = new Error("Unique constraint");
        create.mockRejectedValue(collision);
        await expect(
            createPlaybackTestAccount(credentials, { create, hashPassword }),
        ).rejects.toBe(collision);
        expect(create).toHaveBeenCalledTimes(1);
    });
});
