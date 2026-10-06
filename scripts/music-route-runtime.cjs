/** Runtime bridge for the operator probe; uses the backend's configured Prisma. */
async function run({ prisma, jwt, config, notificationService }, mode, input) {
    if (mode === "token") {
        if (
            typeof input.userId !== "string" ||
            !/^[A-Za-z0-9_-]{1,100}$/.test(input.userId)
        ) {
            throw new Error("invalid_user");
        }
        const user = await prisma.user.findUnique({
            where: { id: input.userId },
            select: {
                id: true,
                isTestAccount: true,
                role: true,
                pendingDeletionAt: true,
                tokenVersion: true,
            },
        });
        if (
            !user ||
            !user.isTestAccount ||
            user.role !== "user" ||
            user.pendingDeletionAt
        ) {
            throw new Error("ineligible_test_account");
        }
        return {
            token: jwt.sign(
                { userId: user.id, tokenVersion: user.tokenVersion },
                config.jwtSecret,
                { algorithm: "HS256", expiresIn: 120 },
            ),
        };
    }
    if (
        mode !== "notify" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            input.incidentId,
        ) ||
        !["outage", "recovery"].includes(input.kind) ||
        !/^(ok|timeout|network|response_size|radio_response|audio_(response|range|body)|runtime_(backend|reply|auth)|http_[1-5][0-9]{2})$/.test(
            input.code,
        )
    ) {
        throw new Error("invalid_notification");
    }
    const admins = await prisma.user.findMany({
        where: { role: "admin", isTestAccount: false, pendingDeletionAt: null },
        select: { id: true },
    });
    if (!admins.length) throw new Error("no_admin");
    const metadata = {
        source: "music_route_monitor",
        deliveryId: `${input.incidentId}:${input.kind}`,
    };
    for (const admin of admins) {
        const exists = await prisma.notification.findFirst({
            where: { userId: admin.id, metadata: { equals: metadata } },
            select: { id: true },
        });
        if (!exists) {
            await notificationService.create({
                userId: admin.id,
                type: "system",
                title:
                    input.kind === "outage"
                        ? "Музыкальный маршрут: повторяющийся сбой"
                        : "Музыкальный маршрут восстановлен",
                message:
                    input.kind === "outage"
                        ? `Три последовательные проверки публичного радио или продолжения аудио не прошли. Код: ${input.code}.`
                        : "Две последовательные проверки публичного радио и продолжения аудио прошли успешно.",
                metadata,
            });
        }
    }
    return { delivered: true };
}

/** Match API bootstrap: config resolves DATABASE_URL before Prisma opens a pool. */
function loadRuntime(requireModule = require) {
    const { config } = requireModule("./dist/config");
    const { prisma } = requireModule("./dist/utils/db");
    return {
        config,
        prisma,
        jwt: requireModule("jsonwebtoken"),
        notificationService: requireModule(
            "./dist/services/notificationService",
        ).notificationService,
    };
}

module.exports = { run, loadRuntime };

if (!module.parent) {
    // Killing docker exec's client does not reliably terminate its container
    // process. Bound database work and disconnect inside the process as well.
    const watchdog = setTimeout(() => process.exit(2), 15000);
    watchdog.unref();
    let prisma;
    (async () => {
        const runtime = loadRuntime();
        prisma = runtime.prisma;
        const reply = await run(
            runtime,
            process.argv[1],
            JSON.parse(require("node:fs").readFileSync(0, "utf8")),
        );
        process.stdout.write(`SOUNDSPAN_MONITOR:${JSON.stringify(reply)}\n`);
    })()
        .catch(() => {
            process.stderr.write("SOUNDSPAN_MONITOR_FAILED\n");
            process.exitCode = 1;
        })
        .finally(async () => {
            if (prisma) await prisma.$disconnect();
            clearTimeout(watchdog);
        });
}
