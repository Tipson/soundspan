import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../utils/db";
import { sanitizePlaybackDiagnosticFields } from "./playbackDiagnostics";

/** Manual incident reasons accepted by the player and the admin notification queue. */
export const playbackFeedbackSchema = z.object({
    reason: z.enum(["wrong_version", "no_sound", "interruption"]),
    reportTrackId: z.string().regex(/^[a-zA-Z0-9_:-]{1,128}$/),
});
const labels = {
    wrong_version: "Не та версия записи",
    no_sound: "Нет звука",
    interruption: "Музыка прервалась",
};

/** Persist an idempotent private notification for each administrator before acknowledging a manual report. */
export async function recordPlaybackFeedback(
    userId: string,
    eventId: string,
    observedAtMs: number,
    input: Record<string, unknown>,
): Promise<void> {
    const report = playbackFeedbackSchema.parse(input);
    const fields = sanitizePlaybackDiagnosticFields(input);
    const [admins, sender] = await Promise.all([
        prisma.user.findMany({
            where: { role: "admin" },
            select: { id: true },
            take: 50,
        }),
        prisma.user.findUnique({
            where: { id: userId },
            select: { username: true },
        }),
    ]);
    if (!admins.length) throw new Error("No administrator available");
    await prisma.notification.createMany({
        skipDuplicates: true,
        data: admins.map((admin) => ({
            id: `playback-report-${createHash("sha256")
                .update(JSON.stringify([userId, eventId, admin.id]))
                .digest("hex")}`,
            userId: admin.id,
            type: "playback_report",
            title: labels[report.reason],
            message: `${sender?.username ?? "Пользователь"}: ${fields.reportArtist ? `${fields.reportArtist} — ` : ""}${fields.reportTitle ?? report.reportTrackId}`,
            metadata: { reporterId: userId, eventId, observedAtMs, fields },
        })),
    });
}
