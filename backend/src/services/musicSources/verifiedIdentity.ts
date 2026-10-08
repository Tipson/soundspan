import { performance } from "node:perf_hooks";
import {
    resolveCanonicalSurvivor,
    runCanonicalIdentityTransaction,
    type ResolvedCanonicalRecording,
} from "../recommendations/canonicalIdentity";
import { readVerifiedMusicSourceRecording } from "./verifiedMetadata";
import { MusicSourceError, type MusicSource } from "./types";

const canonicalSelect = {
    id: true,
    canonicalKey: true,
    mergedIntoId: true,
    identitySource: true,
} as const;

/**
 * Resolve an exact historical server-confirmed namespace without trusting caller display metadata.
 * Keep its stable provider key separate from weak ISRC/meta matching until recording-version compatibility is proven.
 * This creates shared identity only, never account behavior or playback entitlement.
 */
export async function resolveVerifiedMusicSourceIdentity(
    provider: MusicSource,
    providerTrackId: string,
    signal: AbortSignal,
): Promise<ResolvedCanonicalRecording | null> {
    signal.throwIfAborted();
    if (
        !["vk", "yandex"].includes(provider) ||
        typeof providerTrackId !== "string" ||
        !(provider === "vk" ? /^-?\d{1,20}_\d{1,20}$/ : /^\d{1,20}$/).test(
            providerTrackId,
        )
    )
        throw new MusicSourceError("invalid_request");
    const deadline = performance.now() + 5_000;
    const check = () => {
        signal.throwIfAborted();
        if (performance.now() >= deadline)
            throw new MusicSourceError("unavailable");
    };
    const result = await runCanonicalIdentityTransaction(async (tx) => {
        check();
        const statementMs = Math.max(
            1,
            Math.min(
                1_000,
                Math.floor((deadline - performance.now()) / 2) - 10,
            ),
        );
        // Server-local limits also release queries waiting on a row/table lock.
        await tx.$queryRaw`
            SELECT set_config('statement_timeout', ${String(statementMs)}, true),
                set_config('lock_timeout', ${String(statementMs)}, true)
        `;
        check();
        // Prisma cannot express FOR SHARE. Keep the checked facts stable through mapping commit.
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "TrackMusicSource"
            WHERE "provider" = ${provider} AND "providerTrackId" = ${providerTrackId}
            FOR SHARE
        `;
        check();
        if (rows.length !== 1) return null;
        const namespace = await tx.trackMusicSource.findUnique({
            where: { id: rows[0].id },
            select: {
                provider: true,
                providerTrackId: true,
                verifiedMetadata: true,
                metadataObservedAt: true,
                metadataConnectionVersion: true,
            },
        });
        check();
        const recording = readVerifiedMusicSourceRecording(namespace);
        if (!recording) return null;
        const mapping = await tx.trackMapping.findFirst({
            where: { trackMusicSourceId: rows[0].id, stale: false },
            select: {
                id: true,
                canonicalRecording: { select: canonicalSelect },
            },
        });
        check();
        if (mapping?.canonicalRecording) {
            const survivor = await resolveCanonicalSurvivor(
                tx,
                mapping.canonicalRecording,
            );
            check();
            return survivor;
        }
        const canonical = await tx.canonicalRecording.upsert({
            where: { canonicalKey: `provider:${provider}:${providerTrackId}` },
            create: {
                canonicalKey: `provider:${provider}:${providerTrackId}`,
                title: recording.title,
                artist: recording.artists.join(", "),
                duration: Math.round(recording.duration),
                identitySource: "verified-source",
                identityConfidence: 1,
            },
            // Preserve established metadata and shared audio features on retries.
            update: {},
            select: canonicalSelect,
        });
        check();
        const survivor = await resolveCanonicalSurvivor(tx, canonical);
        check();
        if (mapping)
            await tx.trackMapping.update({
                where: { id: mapping.id },
                data: { canonicalRecordingId: survivor.id },
            });
        else
            await tx.trackMapping.create({
                data: {
                    trackMusicSourceId: rows[0].id,
                    canonicalRecordingId: survivor.id,
                    source: "verified-source",
                    confidence: 1,
                },
            });
        check();
        return survivor;
    });
    check();
    return result;
}
