import crypto from "node:crypto";
import bcrypt from "bcrypt";
import express from "express";
import request from "supertest";
import type { Client } from "pg";
import { prisma } from "../src/utils/db";
import { generateToken } from "../src/middleware/auth";
import {
    encrypt2FASecret,
    verifyLoginSecondFactor,
} from "../src/routes/auth/shared";
import registerTestApplicationRoutes from "../src/routes/auth/testApplications";
import registerAdminUserInviteRoutes from "../src/routes/auth/adminUserInvites";
import registerLocalCredentialRoutes from "../src/routes/auth/localCredentials";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

// Only infrastructure unrelated to the account transaction is replaced. HTTP,
// authorization, password hashing, encryption and Prisma use their real code.
jest.mock("../src/middleware/rateLimitStore", () => {
    const { MemoryStore } = jest.requireActual("express-rate-limit");
    return {
        createRedisRateLimitOptions: () => ({ store: new MemoryStore() }),
    };
});
jest.mock("../src/services/listenTogetherUserCleanup", () => ({
    cleanupListenTogetherForUser: jest.fn(),
}));
jest.mock("otplib", () => ({
    // This suite exercises recovery codes, not the unrelated TOTP/ESM adapter.
    verify: () => {
        throw new Error("TOTP is outside this integration suite");
    },
}));

const integrationUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationUrl && databaseName ? describe : describe.skip;
const app = express();
app.use(express.json());
const router = express.Router();
registerTestApplicationRoutes(router);
registerAdminUserInviteRoutes(router);
registerLocalCredentialRoutes(router);
app.use("/api/auth", router);

function registration(
    inviteCode: string,
    username: string,
    email = `${username}@example.test`,
) {
    return {
        inviteCode,
        username,
        email,
        displayName: username,
        password: "test-password-strong",
        confirmPassword: "test-password-strong",
    };
}

async function recoveryUser(username: string) {
    const hashes = ["A1B2C3D4", "E5F6A7B8"].map((code) =>
        crypto.createHash("sha256").update(code).digest("hex"),
    );
    return prisma.user.create({
        data: {
            username,
            twoFactorEnabled: true,
            twoFactorSecret: encrypt2FASecret("JBSWY3DPEHPK3PXP"),
            twoFactorRecoveryCodes: encrypt2FASecret(hashes.join(",")),
        },
    });
}

describeWithPostgres("account access with real PostgreSQL", () => {
    let admin: Client | undefined;
    let adminId: string;
    let adminToken: string;
    beforeAll(async () => {
        admin = await createScaleDatabase(integrationUrl!, databaseName!);
        console.info("Account audit: isolated database created");
        await applyScaleMigrations(process.env.DATABASE_URL!, 300_000);
        console.info("Account audit: migrations applied");
        const account = await prisma.user.create({
            data: {
                username: "audit_admin",
                role: "admin",
                isTestAccount: true,
            },
        });
        adminId = account.id;
        adminToken = generateToken(account);
        console.info("Account audit: synthetic administrator ready");
    }, 330_000);
    afterAll(async () => {
        jest.restoreAllMocks();
        await prisma.$disconnect();
        if (admin) await dropScaleDatabase(admin, databaseName!);
    });

    it("persists, approves, registers once and supports username/email repeat login", async () => {
        const submit = await request(app)
            .post("/api/auth/test-applications")
            .send({ telegram: "@Audit_Listener", device: "iphone" });
        expect(submit.status).toBe(201);
        expect(submit.body).toEqual({ ok: true });
        expect(
            (
                await request(app)
                    .post("/api/auth/test-applications")
                    .send({ telegram: "audit_listener" })
            ).status,
        ).toBe(201);
        expect(await prisma.testApplication.count()).toBe(1);
        expect(
            (await request(app).get("/api/auth/test-applications")).status,
        ).toBe(401);
        const pending = await request(app)
            .get("/api/auth/test-applications")
            .auth(adminToken, { type: "bearer" });
        expect(pending.status).toBe(200);
        expect(pending.body.items[0].status).toBe("pending");
        const applicationId = pending.body.items[0].id as string;
        const approvalPath = `/api/auth/test-applications/${applicationId}/approve`;
        const approvals = await Promise.all(
            [1, 2].map(() =>
                request(app)
                    .post(approvalPath)
                    .auth(adminToken, { type: "bearer" }),
            ),
        );
        expect(approvals.map((response) => response.status)).toEqual([
            200, 200,
        ]);
        expect(approvals[0].body.registrationPath).toBe(
            approvals[1].body.registrationPath,
        );
        expect(await prisma.inviteCode.count()).toBe(1);
        const code = new URL(
            approvals[0].body.registrationPath as string,
            "https://example.test",
        ).searchParams.get("code")!;
        const registered = await request(app)
            .post("/api/auth/register")
            .send(registration(code, "audit_listener"));
        expect(registered.status).toBe(200);
        expect(
            (
                await request(app)
                    .get("/api/auth/me")
                    .auth(registered.body.token as string, { type: "bearer" })
            ).body.username,
        ).toBe("audit_listener");
        expect(
            (
                await request(app)
                    .get("/api/auth/test-applications")
                    .auth(registered.body.token as string, { type: "bearer" })
            ).status,
        ).toBe(403);
        const activated = await request(app)
            .get("/api/auth/test-applications")
            .auth(adminToken, { type: "bearer" });
        expect(activated.body.items[0]).toMatchObject({
            status: "registered",
            username: "audit_listener",
            registrationPath: null,
        });
        for (const username of [
            "audit_listener",
            "audit_listener@example.test",
        ]) {
            const login = await request(app)
                .post("/api/auth/login")
                .send({ username, password: "test-password-strong" });
            expect(login.status).toBe(200);
            expect(
                (
                    await request(app)
                        .get("/api/auth/me")
                        .auth(login.body.token as string, { type: "bearer" })
                ).status,
            ).toBe(200);
        }
        expect(
            (
                await request(app)
                    .post("/api/auth/register")
                    .send(registration(code, "audit_replay"))
            ).status,
        ).toBe(400);
        expect(
            await prisma.user.count({ where: { username: "audit_replay" } }),
        ).toBe(0);
    });

    it.each(["A1B2C3D4", "E5F6A7B8"])(
        "claims overlapping recovery codes atomically (%s)",
        async (secondCode) => {
            const user = await recoveryUser(`recovery_${secondCode}`);
            const results = await Promise.all(
                ["A1B2C3D4", secondCode].map((code) =>
                    verifyLoginSecondFactor(user, code),
                ),
            );
            expect(results.map((result) => result.kind).sort()).toEqual([
                "invalid",
                "ok",
            ]);
            const loserCode =
                results[0].kind === "invalid" ? "A1B2C3D4" : secondCode;
            const current = await prisma.user.findUniqueOrThrow({
                where: { id: user.id },
            });
            expect(
                (await verifyLoginSecondFactor(current, loserCode)).kind,
            ).toBe(secondCode === "A1B2C3D4" ? "invalid" : "ok");
            const afterRetry = await prisma.user.findUniqueOrThrow({
                where: { id: user.id },
            });
            expect(
                (await verifyLoginSecondFactor(afterRetry, "A1B2C3D4")).kind,
            ).toBe("invalid");
        },
    );

    it("preserves a replacement recovery-code set against an already-read login", async () => {
        const user = await recoveryUser("recovery_rotation");
        const replacement = encrypt2FASecret("replacement-code-hash");
        await prisma.user.update({
            where: { id: user.id },
            data: { twoFactorRecoveryCodes: replacement },
        });
        expect((await verifyLoginSecondFactor(user, "A1B2C3D4")).kind).toBe(
            "invalid",
        );
        expect(
            (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
                .twoFactorRecoveryCodes,
        ).toBe(replacement);
    });

    it.each(["username", "email"])(
        "rolls back the losing registration and its invitation claim on concurrent %s",
        async (field) => {
            const invites = await Promise.all(
                [0, 1].map((index) =>
                    prisma.inviteCode.create({
                        data: {
                            code: `AUDIT_${field}_${index}`.toUpperCase(),
                            createdBy: adminId,
                            maxUses: 1,
                        },
                    }),
                ),
            );
            const actualHash = bcrypt.hash.bind(bcrypt);
            let arrived = 0;
            let release: () => void = () => {
                throw new Error("hash gate uninitialized");
            };
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const hash = jest
                .spyOn(bcrypt, "hash")
                .mockImplementation(async (value, rounds) => {
                    if (typeof value !== "string" || typeof rounds !== "number")
                        throw new Error("unexpected test hash input");
                    arrived += 1;
                    if (arrived === 2) release();
                    await gate;
                    return actualHash(value, rounds);
                });
            try {
                const responses = await Promise.all(
                    invites.map((invite, index) =>
                        request(app)
                            .post("/api/auth/register")
                            .send(
                                registration(
                                    invite.code,
                                    field === "username"
                                        ? "username_racer"
                                        : `email_racer_${index}`,
                                    field === "email"
                                        ? "race@example.test"
                                        : `username_racer_${index}@example.test`,
                                ),
                            ),
                    ),
                );
                expect(
                    responses.map((response) => response.status).sort(),
                ).toEqual([200, 400]);
                const loserIndex = responses.findIndex(
                    (response) => response.status === 400,
                );
                expect(responses[loserIndex].body).toEqual({
                    error:
                        field === "username"
                            ? "Username already taken"
                            : "Email already in use",
                });
                expect(
                    await prisma.inviteCode.findUniqueOrThrow({
                        where: { id: invites[loserIndex].id },
                    }),
                ).toMatchObject({ useCount: 0 });
                expect(
                    await prisma.inviteCodeUsage.count({
                        where: { inviteCodeId: invites[loserIndex].id },
                    }),
                ).toBe(0);
            } finally {
                hash.mockRestore();
            }
        },
    );
});
