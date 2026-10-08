import { z } from "zod";
import { prisma } from "../../utils/db";
import {
    MusicSourceError,
    type MusicSourceTrack,
    type VerifiedMusicSourceRecording,
} from "./types";

const recordingSchema = z.object({
    provider: z.enum(["vk", "yandex"]),
    id: z.string().min(1).max(42),
    title: z.string().trim().min(1).max(200),
    artists: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
    duration: z.number().positive().max(3600),
    contentVersion: z.enum(["explicit", "clean", "unknown"]),
    preview: z.literal(false),
    isrc: z
        .string()
        .regex(/^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$/)
        .optional(),
});

const namespaceSchema = z.object({
    provider: z.enum(["vk", "yandex"]),
    providerTrackId: z.string().min(1).max(42),
    verifiedMetadata: recordingSchema,
    metadataObservedAt: z.date(),
    metadataConnectionVersion: z
        .number()
        .int()
        .positive()
        .refine(Number.isSafeInteger),
});

/**
 * Validate the complete stored attestation before using it as shared recording facts.
 * Historical confirmation is independent of current playback entitlement; private Play is never a fallback.
 */
export function readVerifiedMusicSourceRecording(
    namespace: unknown,
): MusicSourceTrack | null {
    const result = namespaceSchema.safeParse(namespace);
    if (!result.success) return null;
    const value = result.data;
    if (
        value.verifiedMetadata.provider !== value.provider ||
        value.verifiedMetadata.id !== value.providerTrackId ||
        !(
            value.provider === "vk" ? /^-?\d{1,20}_\d{1,20}$/ : /^\d{1,20}$/
        ).test(value.providerTrackId)
    )
        return null;
    return value.verifiedMetadata;
}

/**
 * Write only an exact server lookup result, never client display metadata or a Play snapshot.
 * Lock its credential generation and atomically fence older observations; no account behavior is written.
 */
export async function recordVerifiedMusicSourceMetadata(
    input: VerifiedMusicSourceRecording,
    signal: AbortSignal,
    budgetMs: number,
): Promise<void> {
    signal.throwIfAborted();
    const parsed = recordingSchema.safeParse(input.recording);
    if (
        !parsed.success ||
        parsed.data.provider !== input.provider ||
        parsed.data.id !== input.providerTrackId ||
        !(
            input.provider === "vk" ? /^-?\d{1,20}_\d{1,20}$/ : /^\d{1,20}$/
        ).test(input.providerTrackId) ||
        !Number.isSafeInteger(input.connectionVersion) ||
        input.connectionVersion <= 0 ||
        !(input.observedAt instanceof Date) ||
        !Number.isFinite(input.observedAt.getTime()) ||
        !Number.isFinite(budgetMs) ||
        budgetMs < 2 ||
        budgetMs > 500
    )
        throw new MusicSourceError("invalid_request");
    const metadata = parsed.data;
    const provider = input.provider;
    const providerTrackId = input.providerTrackId;
    const connectionVersion = input.connectionVersion;
    const observedAt = new Date(input.observedAt.getTime());
    const totalMs = Math.floor(budgetMs);
    const deadline = performance.now() + totalMs;
    const check = () => {
        signal.throwIfAborted();
        if (performance.now() >= deadline)
            throw new MusicSourceError("unavailable");
    };
    check();
    await prisma.$transaction(
        async (tx) => {
            check();
            // An interactive transaction timeout alone does not cancel a waiting pg query.
            // Set local server limits before any row/table lock so the pool cannot remain blocked.
            const statementMs = Math.max(
                1,
                Math.min(
                    Math.floor(totalMs / 2) - 10,
                    Math.floor(deadline - performance.now()) - 10,
                ),
            );
            await tx.$queryRaw`
                SELECT set_config('statement_timeout', ${String(statementMs)}, true),
                    set_config('lock_timeout', ${String(statementMs)}, true)
            `;
            check();
            // Prisma cannot express FOR SHARE; bind only validated values and read no credential token.
            const connections = await tx.$queryRaw<Array<{ version: number }>>`
                SELECT "version" FROM "MusicSourceConnection"
                WHERE "id" = ${provider} AND "enabled" = true
                    AND "version" = ${connectionVersion}
                FOR SHARE
            `;
            check();
            if (connections.length !== 1) return;
            const namespace = await tx.trackMusicSource.upsert({
                where: {
                    provider_providerTrackId: {
                        provider,
                        providerTrackId,
                    },
                },
                create: {
                    provider,
                    providerTrackId,
                },
                update: { provider },
                select: { id: true },
            });
            check();
            await tx.trackMusicSource.updateMany({
                where: {
                    id: namespace.id,
                    OR: [
                        { metadataConnectionVersion: null },
                        {
                            metadataConnectionVersion: {
                                lt: connectionVersion,
                            },
                        },
                        {
                            metadataConnectionVersion: connectionVersion,
                            metadataObservedAt: { lte: observedAt },
                        },
                    ],
                },
                data: {
                    verifiedMetadata: metadata,
                    metadataObservedAt: observedAt,
                    metadataConnectionVersion: connectionVersion,
                },
            });
            check();
        },
        { maxWait: Math.floor(totalMs / 2), timeout: Math.ceil(totalMs / 2) },
    );
}
