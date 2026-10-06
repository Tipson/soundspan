const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run, loadRuntime } = require("../music-route-runtime.cjs");

function fixture(
    user = {
        id: "test-user",
        isTestAccount: true,
        role: "user",
        pendingDeletionAt: null,
        tokenVersion: 5,
    },
) {
    const records = [];
    const signed = [];
    return {
        records,
        signed,
        deps: {
            prisma: {
                user: {
                    findUnique: async () => user,
                    findMany: async () => [{ id: "admin-id" }],
                },
                notification: {
                    findFirst: async ({ where }) =>
                        records.find(
                            (record) =>
                                record.userId === where.userId &&
                                record.metadata.deliveryId ===
                                    where.metadata.equals.deliveryId,
                        ),
                },
            },
            config: { jwtSecret: "key-inside-container" },
            jwt: {
                sign: (...args) => {
                    signed.push(args);
                    return "short-token";
                },
            },
            notificationService: {
                create: async (record) => {
                    records.push(record);
                    return record;
                },
            },
        },
    };
}

test("only a non-admin test account receives a short versioned token", async () => {
    const f = fixture();
    assert.deepEqual(await run(f.deps, "token", { userId: "test-user" }), {
        token: "short-token",
    });
    assert.deepEqual(f.signed[0], [
        { userId: "test-user", tokenVersion: 5 },
        "key-inside-container",
        { algorithm: "HS256", expiresIn: 120 },
    ]);
    for (const changes of [
        { isTestAccount: false },
        { role: "admin" },
        { pendingDeletionAt: new Date() },
    ]) {
        const rejected = fixture({
            id: "test-user",
            isTestAccount: true,
            role: "user",
            pendingDeletionAt: null,
            tokenVersion: 0,
            ...changes,
        });
        await assert.rejects(
            run(rejected.deps, "token", { userId: "test-user" }),
            /ineligible/,
        );
        assert.equal(rejected.signed.length, 0);
    }
});

test("runtime resolves container configuration before opening the database", () => {
    let configured = false;
    const f = fixture();
    const deps = loadRuntime((name) => {
        if (name === "./dist/config") {
            configured = true;
            return { config: f.deps.config };
        }
        if (name === "./dist/utils/db") {
            assert.ok(
                configured,
                "database must not use its localhost fallback",
            );
            return { prisma: f.deps.prisma };
        }
        if (name === "jsonwebtoken") return f.deps.jwt;
        if (name === "./dist/services/notificationService")
            return { notificationService: f.deps.notificationService };
        throw new Error("unexpected runtime dependency");
    });
    assert.deepEqual(deps, f.deps);
});

test("delivery retries use the same id and notify administrators only", async () => {
    const f = fixture();
    const event = {
        incidentId: "a82b64f4-2739-4f15-8d17-725576a3bf80",
        kind: "outage",
        code: "audio_body",
    };
    await run(f.deps, "notify", event);
    await run(f.deps, "notify", event);
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].userId, "admin-id");
    assert.equal(f.records[0].type, "system");
    await run(f.deps, "notify", { ...event, kind: "recovery" });
    assert.equal(f.records.length, 2);
});

test("no admin or malformed notification cannot be reported as delivered", async () => {
    const f = fixture();
    const event = {
        incidentId: "a82b64f4-2739-4f15-8d17-725576a3bf80",
        kind: "outage",
        code: "audio_body",
    };
    f.deps.prisma.user.findMany = async () => [];
    await assert.rejects(run(f.deps, "notify", event), /no_admin/);
    await assert.rejects(
        run(f.deps, "notify", { ...event, incidentId: "user supplied text" }),
        /invalid/,
    );
    assert.equal(f.records.length, 0);
});

test("partially delivered incidents retry only the missing administrator", async () => {
    const f = fixture();
    f.deps.prisma.user.findMany = async ({ where }) => {
        assert.deepEqual(where, {
            role: "admin",
            isTestAccount: false,
            pendingDeletionAt: null,
        });
        return [{ id: "admin-id" }, { id: "second-admin" }];
    };
    const event = {
        incidentId: "a82b64f4-2739-4f15-8d17-725576a3bf80",
        kind: "outage",
        code: "http_503",
    };
    let fail = true;
    f.deps.notificationService.create = async (record) => {
        if (record.userId === "second-admin" && fail)
            throw new Error("db down");
        f.records.push(record);
    };
    await assert.rejects(run(f.deps, "notify", event));
    fail = false;
    await run(f.deps, "notify", event);
    assert.deepEqual(
        f.records.map((record) => record.userId),
        ["admin-id", "second-admin"],
    );
});
