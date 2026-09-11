import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../utils/db";

/** Safe failure returned by the testing application workflow. */
export class TestApplicationError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const submissionSchema = z.object({
    telegram: z
        .string()
        .trim()
        .max(80)
        .transform((value) =>
            value
                .replace(/^https:\/\/t\.me\//, "")
                .replace(/^@/, "")
                .toLowerCase(),
        )
        .pipe(z.string().regex(/^[a-z][a-z0-9_]{4,31}$/)),
    device: z
        .enum(["", "android", "iphone", "desktop", "multiple"])
        .default(""),
    website: z.string().max(0).optional(),
});
const applicationInclude = {
    inviteCode: {
        include: {
            usages: { include: { user: { select: { username: true } } } },
        },
    },
} satisfies Prisma.TestApplicationInclude;
type ApplicationRow = Prisma.TestApplicationGetPayload<{
    include: typeof applicationInclude;
}>;

/** Administrator-only representation; invitation secrets are never returned publicly. */
export function summarizeTestApplication(row: ApplicationRow) {
    const invite = row.inviteCode;
    const registered = Boolean(invite?.useCount);
    const unavailable = Boolean(
        invite?.revoked ||
        (invite?.expiresAt && invite.expiresAt <= new Date()),
    );
    return {
        id: row.id,
        telegram: row.telegram,
        device: row.device,
        createdAt: row.createdAt.toISOString(),
        approvedAt: row.approvedAt?.toISOString() ?? null,
        status: registered
            ? "registered"
            : unavailable
              ? "revoked"
              : invite
                ? "approved"
                : "pending",
        username: invite?.usages[0]?.user.username ?? null,
        registrationPath:
            invite && !registered && !unavailable
                ? `/register?code=${encodeURIComponent(invite.code)}`
                : null,
    };
}

/** Persists a normalized contact once, preserving the original application on retries. */
export async function submitTestApplication(input: unknown): Promise<void> {
    const parsed = submissionSchema.safeParse(input);
    if (!parsed.success)
        throw new TestApplicationError(
            400,
            "Проверьте имя Telegram и выбранное устройство.",
        );
    const { telegram, device } = parsed.data;
    await prisma.testApplication.upsert({
        where: { telegram },
        create: { telegram, device },
        update: {},
    });
}

/** Returns a bounded administrator page with stable cursor pagination. */
export async function listTestApplications(cursor?: string) {
    const rows = await prisma.testApplication.findMany({
        take: 51,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: applicationInclude,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, 50);
    return {
        items: page.map(summarizeTestApplication),
        nextCursor: rows.length > 50 ? page[49].id : null,
    };
}

/** Approves once, atomically linking a single-use invitation even under concurrent retries. */
export async function approveTestApplication(id: string, adminId: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await prisma.$transaction(
                async (tx) => {
                    const row = await tx.testApplication.findUnique({
                        where: { id },
                        include: applicationInclude,
                    });
                    if (!row)
                        throw new TestApplicationError(
                            404,
                            "Заявка не найдена.",
                        );
                    if (row.inviteCode) return summarizeTestApplication(row);
                    const invite = await tx.inviteCode.create({
                        data: {
                            code: crypto
                                .randomBytes(16)
                                .toString("hex")
                                .toUpperCase(),
                            createdBy: adminId,
                            maxUses: 1,
                            expiresAt: null,
                        },
                    });
                    const approved = await tx.testApplication.update({
                        where: { id },
                        data: {
                            inviteCodeId: invite.id,
                            approvedAt: new Date(),
                        },
                        include: applicationInclude,
                    });
                    return summarizeTestApplication(approved);
                },
                {
                    isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                },
            );
        } catch (error) {
            if (
                !(
                    typeof error === "object" &&
                    error !== null &&
                    "code" in error &&
                    error.code === "P2034"
                ) ||
                attempt === 2
            )
                throw error;
        }
    }
    throw new TestApplicationError(503, "Повторите одобрение заявки.");
}
