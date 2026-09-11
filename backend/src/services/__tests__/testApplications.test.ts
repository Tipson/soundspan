const mockDb = {
    testApplication: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
    },
    inviteCode: { create: jest.fn() },
    $transaction: jest.fn(),
};
jest.mock("../../utils/db", () => ({ prisma: mockDb }));

import {
    submitTestApplication,
    approveTestApplication,
    listTestApplications,
} from "../testApplications";

const pending = {
    id: "application-1",
    telegram: "listener_name",
    device: "android",
    createdAt: new Date(),
    approvedAt: null,
    inviteCode: null,
};
const invite = {
    id: "invite-1",
    code: "PRIVATE_INVITE",
    revoked: false,
    useCount: 0,
    expiresAt: null,
    usages: [],
};

beforeEach(() => {
    jest.resetAllMocks();
    mockDb.$transaction.mockImplementation(
        (run: (tx: typeof mockDb) => unknown) => run(mockDb),
    );
    mockDb.testApplication.findUnique.mockResolvedValue(pending);
    mockDb.inviteCode.create.mockResolvedValue(invite);
    mockDb.testApplication.update.mockResolvedValue({
        ...pending,
        approvedAt: new Date(),
        inviteCode: invite,
    });
});

test("submission normalizes Telegram and does not overwrite a prior application", async () => {
    await submitTestApplication({
        telegram: " https://t.me/Listener_Name ",
        device: "android",
    });
    expect(mockDb.testApplication.upsert).toHaveBeenCalledWith({
        where: { telegram: "listener_name" },
        create: { telegram: "listener_name", device: "android" },
        update: {},
    });
});

test.each(["abc", "https://evil.test/listener", "<script>alert(1)</script>"])(
    "rejects invalid contact %s",
    async (telegram) => {
        await expect(submitTestApplication({ telegram })).rejects.toMatchObject(
            { status: 400 },
        );
        expect(mockDb.testApplication.upsert).not.toHaveBeenCalled();
    },
);

test("rejects unknown devices and filled honeypot", async () => {
    await expect(
        submitTestApplication({ telegram: "listener_name", device: "server" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
        submitTestApplication({ telegram: "listener_name", website: "spam" }),
    ).rejects.toMatchObject({ status: 400 });
});

test("approval creates a single-use invite and links it atomically", async () => {
    const result = await approveTestApplication("application-1", "admin-1");
    expect(result.status).toBe("approved");
    expect(result.registrationPath).toBe("/register?code=PRIVATE_INVITE");
    expect(mockDb.inviteCode.create.mock.calls[0][0].data).toMatchObject({
        createdBy: "admin-1",
        maxUses: 1,
        expiresAt: null,
    });
    expect(
        mockDb.testApplication.update.mock.calls[0][0].data.inviteCodeId,
    ).toBe("invite-1");
    expect(mockDb.$transaction.mock.calls[0][1]).toMatchObject({
        isolationLevel: "Serializable",
    });
});

test("repeated approval returns the same invitation without creating another", async () => {
    mockDb.testApplication.findUnique.mockResolvedValue({
        ...pending,
        inviteCode: invite,
    });
    expect(
        (await approveTestApplication("application-1", "admin-1"))
            .registrationPath,
    ).toBe("/register?code=PRIVATE_INVITE");
    expect(mockDb.inviteCode.create).not.toHaveBeenCalled();
});

test("a registration is visible to the administrator and no consumed link is offered", async () => {
    mockDb.testApplication.findMany.mockResolvedValue([
        {
            ...pending,
            inviteCode: {
                ...invite,
                useCount: 1,
                usages: [{ user: { username: "new_listener" } }],
            },
        },
    ]);
    const result = await listTestApplications();
    expect(result.items[0]).toMatchObject({
        status: "registered",
        username: "new_listener",
        registrationPath: null,
    });
});

test("retries a serializable conflict without swallowing other database errors", async () => {
    mockDb.$transaction.mockRejectedValueOnce({ code: "P2034" });
    await approveTestApplication("application-1", "admin-1");
    expect(mockDb.$transaction).toHaveBeenCalledTimes(2);
    mockDb.$transaction.mockRejectedValueOnce(
        new Error("database unavailable"),
    );
    await expect(
        approveTestApplication("application-1", "admin-1"),
    ).rejects.toThrow("database unavailable");
});

test("missing application cannot create an invitation", async () => {
    mockDb.testApplication.findUnique.mockResolvedValue(null);
    await expect(
        approveTestApplication("missing", "admin-1"),
    ).rejects.toMatchObject({ status: 404 });
    expect(mockDb.inviteCode.create).not.toHaveBeenCalled();
});
