import { prisma } from "../../utils/db";
import { encrypt, decrypt } from "../../utils/encryption";
import { createMusicSourceAdapter } from "./adapters";
import {
    MusicSourceError,
    type MusicSource,
    type MusicSourceAdapter,
} from "./types";

const providers = new Set(["yandex", "vk"]);
/** Redacted administrative connection state, never a credential read endpoint. */
export async function listMusicSourceConnections() {
    const rows = await prisma.musicSourceConnection.findMany();
    return rows
        .filter((r) => providers.has(r.id))
        .map((r) => ({
            provider: r.id as MusicSource,
            configured: Boolean(r.token),
            enabled: r.enabled,
            version: r.version,
            updatedAt: r.updatedAt,
        }));
}
/** Encrypt or disable a dedicated service connection and invalidate its prior generation. */
export async function saveMusicSourceConnection(
    provider: MusicSource,
    input: { token?: string; enabled: boolean },
) {
    if (!providers.has(provider)) throw new MusicSourceError("invalid_request");
    if (input.token) {
        if (input.token.length > 8192 || /\s/.test(input.token))
            throw new MusicSourceError("invalid_request");
        const token = encrypt(input.token);
        await prisma.musicSourceConnection.upsert({
            where: { id: provider },
            create: { id: provider, token, enabled: input.enabled },
            update: {
                token,
                enabled: input.enabled,
                version: { increment: 1 },
            },
        });
    } else {
        const updated = await prisma.musicSourceConnection.updateMany({
            where: { id: provider },
            data: { enabled: input.enabled, version: { increment: 1 } },
        });
        if (!updated?.count && input.enabled)
            throw new MusicSourceError("auth_required");
    }
}
/** Load immutable service credentials afresh so disables and rotations fence future requests. */
export async function loadMusicSourceAdapters(): Promise<MusicSourceAdapter[]> {
    const rows = await prisma.musicSourceConnection.findMany({
        orderBy: { id: "asc" },
    });
    const result: MusicSourceAdapter[] = [];
    for (const row of rows) {
        if (!row.enabled || !providers.has(row.id)) continue;
        try {
            const token = decrypt(row.token);
            if (token)
                result.push(
                    createMusicSourceAdapter(
                        row.id as MusicSource,
                        token,
                        row.version,
                    ),
                );
        } catch {
            /* A corrupt credential fails closed without logging ciphertext. */
        }
    }
    return result;
}
