import bcrypt from "bcrypt";
import { createPrismaClient } from "../utils/prismaClientFactory";
import { createPlaybackTestAccount } from "../services/playbackTestAccount";

/** Operator-only bootstrap; bounded JSON credentials arrive on private stdin. */
async function main(): Promise<void> {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
        input += chunk.toString("utf8");
        if (Buffer.byteLength(input, "utf8") > 4096) {
            throw new RangeError("Test credentials exceed input limit");
        }
    }
    const credentials: unknown = JSON.parse(input);
    const prisma = createPrismaClient();
    try {
        const identity = await createPlaybackTestAccount(credentials, {
            hashPassword: (password) => bcrypt.hash(password, 12),
            create: (data) =>
                prisma.user.create({
                    data,
                    select: { id: true, username: true },
                }),
        });
        process.stdout.write(`${JSON.stringify(identity)}\n`);
    } finally {
        await prisma.$disconnect();
    }
}

void main().catch(() => {
    process.stderr.write(
        "Test account creation failed. Check credentials, name availability and database migrations. No existing account was changed.\n",
    );
    process.exitCode = 1;
});
