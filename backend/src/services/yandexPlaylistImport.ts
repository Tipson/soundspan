import { z } from "zod";
import type { ImportTrackMeta } from "./playlistImportService";
import { musicSourceHttp } from "./musicSources/transport";
import { MusicSourceError } from "./musicSources/types";

const uuidPattern =
    /^(?:[a-z]{1,16}\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ownerPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const kindPattern = /^\d{1,20}$/;
const maxTracks = 10_000;
const batchSize = 100;
const identifier = z
    .union([
        z.string().regex(kindPattern),
        z.number().int().nonnegative().refine(Number.isSafeInteger),
    ])
    .transform(String);
const text = z.string().trim().min(1).max(1000);
const trackSchema = z.object({
    id: identifier,
    title: text,
    version: z.string().trim().max(200).nullish(),
    artists: z
        .array(z.object({ name: text }))
        .min(1)
        .max(50),
    albums: z
        .array(z.object({ title: text }))
        .max(100)
        .optional(),
    durationMs: z.number().finite().nonnegative().max(36_000_000).optional(),
    isrc: z.string().max(100).nullish(),
});
const playlistSchema = z.object({
    title: text,
    visibility: z.literal("public"),
    trackCount: z.number().int().nonnegative().max(maxTracks),
    tracks: z
        .array(
            z.object({
                id: identifier,
                albumId: identifier.nullish(),
                track: z.unknown().optional(),
            }),
        )
        .max(maxTracks),
});
const messages = {
    invalid: "Некорректная ссылка на плейлист Яндекс Музыки.",
    private:
        "Плейлист Яндекс Музыки недоступен. Сделайте его публичным и повторите импорт.",
    incomplete:
        "Яндекс Музыка вернула неполный список треков. Импорт не выполнен — повторите позже.",
    rate_limit: "Яндекс Музыка ограничила запросы. Повторите импорт позже.",
    unavailable: "Яндекс Музыка временно недоступна. Повторите импорт позже.",
} as const;

/** Safe import failure; only transient provider outages allow automatic retries. */
export class YandexPlaylistImportError extends Error {
    readonly providerFailure: boolean;
    constructor(readonly code: keyof typeof messages) {
        super(messages[code]);
        this.name = "YandexPlaylistImportError";
        this.providerFailure = code === "unavailable";
    }
    /** Persist code-owned text without upstream bodies, URLs, or credentials. */
    codeOwnedMessage(): string {
        return messages[this.code];
    }
}

/** Recognize public share URLs; identifiers alone determine the fixed API path. */
export function parseYandexPlaylistUrl(url: URL): string | null {
    if (
        !["https:", "http:"].includes(url.protocol) ||
        ![
            "music.yandex.ru",
            "music.yandex.com",
            "music.yandex.kz",
            "music.yandex.by",
            "music.yandex.uz",
        ].includes(url.hostname.toLowerCase()) ||
        url.username ||
        url.password ||
        url.port
    )
        return null;
    const legacy = /^\/users\/([^/]+)\/playlists\/(\d{1,20})\/?$/.exec(
        url.pathname,
    );
    if (legacy && ownerPattern.test(legacy[1])) {
        return `${legacy[1].toLowerCase()}:${BigInt(legacy[2]).toString()}`;
    }
    const modern = /^\/playlists\/([^/]+)\/?$/.exec(url.pathname);
    return modern && uuidPattern.test(modern[1])
        ? modern[1].toLowerCase()
        : null;
}

function apiPath(sourceId: string): string {
    if (uuidPattern.test(sourceId)) return `/playlist/${sourceId}`;
    const [owner, kind, extra] = sourceId.split(":");
    if (
        extra !== undefined ||
        !ownerPattern.test(owner) ||
        !kind ||
        !kindPattern.test(kind)
    ) {
        throw new YandexPlaylistImportError("invalid");
    }
    return `/users/${owner}/playlists/${kind}`;
}

function metadata(track: z.infer<typeof trackSchema>): ImportTrackMeta {
    return {
        artist: track.artists.map((artist) => artist.name).join(", "),
        title: track.title + (track.version ? ` (${track.version})` : ""),
        ...(track.albums?.[0] ? { album: track.albums[0].title } : {}),
        ...(track.durationMs !== undefined
            ? { duration: track.durationMs / 1000 }
            : {}),
        ...(track.isrc ? { isrc: track.isrc } : {}),
    };
}

/** Read all public playlist positions anonymously; never use the shared service token. */
export async function fetchYandexPlaylistForImport(
    sourceId: string,
    parentSignal?: AbortSignal,
): Promise<{ name: string; tracks: ImportTrackMeta[] }> {
    const path = apiPath(sourceId);
    const signal = AbortSignal.any([
        AbortSignal.timeout(120_000),
        ...(parentSignal ? [parentSignal] : []),
    ]);
    try {
        signal.throwIfAborted();
        const raw = await musicSourceHttp.json(
            `https://api.music.yandex.net${path}?rich-tracks=false`,
            {},
            signal,
        );
        signal.throwIfAborted();
        const envelope = z.object({ result: z.unknown() }).safeParse(raw);
        if (!envelope.success)
            throw new YandexPlaylistImportError("unavailable");
        const publicState = z
            .object({ visibility: z.literal("public") })
            .safeParse(envelope.data.result);
        if (!publicState.success)
            throw new YandexPlaylistImportError("private");
        const parsed = playlistSchema.safeParse(envelope.data.result);
        if (
            !parsed.success ||
            parsed.data.trackCount !== parsed.data.tracks.length
        ) {
            throw new YandexPlaylistImportError("incomplete");
        }
        const playlist = parsed.data;
        const recordings = new Map<string, ImportTrackMeta>();
        const missing = new Map<string, string>();
        for (const row of playlist.tracks) {
            const nested = trackSchema.safeParse(row.track);
            if (nested.success && nested.data.id === row.id)
                recordings.set(row.id, metadata(nested.data));
            else
                missing.set(
                    row.id,
                    row.albumId ? `${row.id}:${row.albumId}` : row.id,
                );
        }
        const ids = [...missing.values()];
        for (let start = 0; start < ids.length; start += batchSize) {
            signal.throwIfAborted();
            const batch = ids.slice(start, start + batchSize);
            const response = await musicSourceHttp.json(
                "https://api.music.yandex.net/tracks",
                {},
                signal,
                { "track-ids": batch.join(",") },
            );
            signal.throwIfAborted();
            const details = z
                .object({ result: z.array(trackSchema).max(batchSize) })
                .safeParse(response);
            if (!details.success)
                throw new YandexPlaylistImportError("incomplete");
            const requested = new Set(
                batch.map((value) => value.split(":")[0]),
            );
            for (const track of details.data.result) {
                if (!requested.has(track.id))
                    throw new YandexPlaylistImportError("incomplete");
                recordings.set(track.id, metadata(track));
            }
            if ([...requested].some((id) => !recordings.has(id)))
                throw new YandexPlaylistImportError("incomplete");
        }
        return {
            name: playlist.title,
            tracks: playlist.tracks.map((row) => {
                const track = recordings.get(row.id);
                if (!track) throw new YandexPlaylistImportError("incomplete");
                return { ...track };
            }),
        };
    } catch (error) {
        if (error instanceof YandexPlaylistImportError) throw error;
        if (error instanceof MusicSourceError) {
            if (error.code === "rate_limit")
                throw new YandexPlaylistImportError("rate_limit");
            if (
                ["auth_required", "entitlement_required", "not_found"].includes(
                    error.code,
                )
            )
                throw new YandexPlaylistImportError("private");
        }
        throw new YandexPlaylistImportError("unavailable");
    }
}
