import {
    DashboardSessions,
    DashboardStateUnavailableError,
    type DashboardBinding,
} from "../dashboardSessions";

const id = "a".repeat(48);
const hash = "b".repeat(64);
const value: DashboardBinding = {
    ownerId: "admin-1",
    tokenVersion: 2,
    epoch: "c".repeat(48),
    grantNonce: null,
    bearerHash: hash,
};

function fixture(ready = true) {
    const evalCommand = jest.fn<
        Promise<unknown>,
        [string, { keys: string[]; arguments: string[] }]
    >();
    return {
        command: evalCommand,
        sessions: new DashboardSessions({ isReady: ready, eval: evalCommand }),
    };
}

test("unready Redis fails closed before dispatching a command", async () => {
    const { sessions, command } = fixture(false);
    await expect(sessions.read(id)).rejects.toBeInstanceOf(
        DashboardStateUnavailableError,
    );
    expect(command).not.toHaveBeenCalled();
});

test("Redis command errors retain their cause without becoming authorization", async () => {
    const { sessions, command } = fixture();
    const cause = new Error("fixture dependency unavailable");
    command.mockRejectedValueOnce(cause);
    await expect(sessions.read(id)).rejects.toMatchObject({
        name: "DashboardStateUnavailableError",
        cause,
    });
    const alreadyTyped = new DashboardStateUnavailableError();
    command.mockRejectedValueOnce(alreadyTyped);
    await expect(sessions.read(id)).rejects.toBe(alreadyTyped);
});

test("a hanging Redis operation is bounded and clears its deadline timer", async () => {
    jest.useFakeTimers();
    const { sessions, command } = fixture();
    command.mockReturnValue(new Promise(() => undefined));
    try {
        const result = sessions.read(id);
        const rejected = expect(result).rejects.toMatchObject({
            name: "DashboardStateUnavailableError",
            operation: "read",
            completionUnknown: true,
        });
        await jest.advanceTimersByTimeAsync(1500);
        await rejected;
        expect(jest.getTimerCount()).toBe(0);
    } finally {
        jest.useRealTimers();
    }
});

test("bootstrap requires a non-authenticating record and reports store admission", async () => {
    const { sessions, command } = fixture();
    command.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(sessions.bootstrap(id, value)).resolves.toBe(true);
    await expect(sessions.bootstrap(id, value)).resolves.toBe(false);
    await expect(
        sessions.bootstrap(id, { ...value, grantNonce: "d".repeat(48) }),
    ).rejects.toThrow("cannot issue a grant");
    await expect(
        sessions.bootstrap(id, {
            ...value,
            bearerHash: "raw-invalid-credential",
        }),
    ).rejects.toThrow();
});

test("absent state is empty and valid state crosses the parsed boundary", async () => {
    const { sessions, command } = fixture();
    command
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify(value));
    await expect(sessions.read(id)).resolves.toBeNull();
    await expect(sessions.read(id)).resolves.toEqual(value);
});

test.each([3, "not-json", JSON.stringify({ ...value, ownerId: null })])(
    "invalid stored state %p never authenticates",
    async (stored) => {
        const { sessions, command } = fixture();
        command.mockResolvedValue(stored);
        await expect(sessions.read(id)).rejects.toBeInstanceOf(
            DashboardStateUnavailableError,
        );
    },
);

test("mint reports compare-and-set rejection without pretending success", async () => {
    const { sessions, command } = fixture();
    command.mockResolvedValueOnce(0).mockResolvedValueOnce("d".repeat(48));
    await expect(
        sessions.mint(id, value, "d".repeat(48), hash),
    ).resolves.toBeNull();
    await expect(sessions.mint(id, value, "d".repeat(48), hash)).resolves.toBe(
        "d".repeat(48),
    );
});

test("an invalid Redis grant reply never becomes a signed credential", async () => {
    const { sessions, command } = fixture();
    command.mockResolvedValue(1);
    await expect(
        sessions.mint(id, value, "d".repeat(48), hash),
    ).rejects.toBeInstanceOf(DashboardStateUnavailableError);
});

test("cookie authorization needs every exact grant field", async () => {
    const { sessions, command } = fixture();
    const nonce = "d".repeat(48);
    command.mockResolvedValue(JSON.stringify({ ...value, grantNonce: nonce }));
    await expect(sessions.grantActive(id, value, nonce)).resolves.toBe(true);
    await expect(
        sessions.grantActive(id, { ...value, ownerId: "other" }, nonce),
    ).resolves.toBe(false);
    await expect(
        sessions.grantActive(id, { ...value, tokenVersion: 3 }, nonce),
    ).resolves.toBe(false);
    await expect(
        sessions.grantActive(id, { ...value, epoch: "e".repeat(48) }, nonce),
    ).resolves.toBe(false);
    await expect(sessions.grantActive(id, value, "f".repeat(48))).resolves.toBe(
        false,
    );
    command.mockResolvedValue(null);
    await expect(sessions.grantActive(id, value, nonce)).resolves.toBe(false);
});

test("anonymous revocation is a no-op and explicit revocation stays scoped", async () => {
    const { sessions, command } = fixture();
    command.mockResolvedValue(1);
    await sessions.revoke(null, null);
    expect(command).not.toHaveBeenCalled();
    await sessions.revoke(id, hash);
    await sessions.revoke(id, null, false);
    await sessions.revoke(null, hash);
    expect(command).toHaveBeenCalledTimes(3);
});
