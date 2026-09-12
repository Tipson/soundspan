import { createHash } from "node:crypto";
import { z } from "zod";
import {
    MusicSourceError,
    type MusicSource,
    type MusicSourceTrack,
    type MusicSourceAdapter,
} from "./types";
import {
    isMusicSourceUrlAllowed,
    musicSourceHttp,
    type MusicSourceHttp,
} from "./transport";

const text = z.string().min(1).max(500);
const id = z
    .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
    .transform(String);
const yandexTrack = z.object({
    id,
    title: text,
    version: z.string().max(200).optional(),
    artists: z
        .array(z.object({ name: text }))
        .min(1)
        .max(20),
    durationMs: z.number().positive().max(3_600_000),
    available: z.boolean().optional(),
    contentWarning: z.string().optional(),
    isrc: z.string().optional(),
});
const vkTrack = z.object({
    id: z.number().int().positive(),
    owner_id: z.number().int(),
    title: text,
    subtitle: z.string().max(200).optional(),
    artist: text,
    duration: z.number().positive().max(3600),
    is_explicit: z.boolean().optional(),
    url: z.string().optional(),
    is_restricted: z.boolean().optional(),
});
const envelope = z.object({
    result: z.unknown().optional(),
    response: z.unknown().optional(),
    error: z.unknown().optional(),
});
function parseEnvelope(raw: unknown): z.infer<typeof envelope> {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) throw new MusicSourceError("unavailable");
    if (parsed.data.error) {
        const error = z
            .object({ error_code: z.number().optional() })
            .safeParse(parsed.data.error);
        const code = error.success ? error.data.error_code : undefined;
        if (code === 14) throw new MusicSourceError("provider_challenge");
        if (code === 5) throw new MusicSourceError("auth_required");
        if (code === 6 || code === 9 || code === 29)
            throw new MusicSourceError("rate_limit");
        if (code === 15 || code === 201)
            throw new MusicSourceError("entitlement_required");
        throw new MusicSourceError("unavailable");
    }
    return parsed.data;
}
function normalize(
    provider: MusicSource,
    raw: unknown,
): MusicSourceTrack | null {
    if (provider === "yandex") {
        const parsed = yandexTrack.safeParse(raw);
        if (!parsed.success || parsed.data.available === false) return null;
        const t = parsed.data;
        return {
            provider,
            id: t.id,
            title: t.title + (t.version ? ` (${t.version})` : ""),
            artists: t.artists.map((a) => a.name),
            duration: t.durationMs / 1000,
            contentVersion:
                t.contentWarning === "explicit" ? "explicit" : "unknown",
            preview: false,
            ...(t.isrc ? { isrc: t.isrc } : {}),
        };
    }
    const parsed = vkTrack.safeParse(raw);
    if (!parsed.success || parsed.data.is_restricted) return null;
    const t = parsed.data;
    return {
        provider,
        id: `${t.owner_id}_${t.id}`,
        title: t.title + (t.subtitle ? ` (${t.subtitle})` : ""),
        artists: [t.artist],
        duration: t.duration,
        contentVersion: t.is_explicit ? "explicit" : "unknown",
        preview: false,
    };
}
function assertId(provider: MusicSource, value: string) {
    if (
        !(provider === "yandex" ? /^\d{1,20}$/ : /^-?\d{1,20}_\d{1,20}$/).test(
            value,
        )
    )
        throw new MusicSourceError("invalid_request");
}
/** Direct HTTP adapters following LavaSrc's provider protocols, without a player runtime. */
export function createMusicSourceAdapter(
    provider: MusicSource,
    token: string,
    version: number,
    http: MusicSourceHttp = musicSourceHttp,
): MusicSourceAdapter {
    const call = async (path: string, signal: AbortSignal) =>
        parseEnvelope(
            await http.json(
                provider === "yandex"
                    ? `https://api.music.yandex.net${path}`
                    : `https://api.vk.com/method/${path}${path.includes("?") ? "&" : "?"}v=5.199`,
                provider === "yandex"
                    ? { Authorization: `OAuth ${token}` }
                    : {},
                signal,
                provider === "vk" ? { access_token: token } : undefined,
            ),
        );
    return {
        provider,
        version,
        enabled: true,
        async search(query, signal) {
            if (!query.trim() || query.length > 500)
                throw new MusicSourceError("invalid_request");
            const data = await call(
                provider === "yandex"
                    ? `/search?type=track&page=0&text=${encodeURIComponent(query)}`
                    : `audio.search?sort=2&count=20&q=${encodeURIComponent(query)}`,
                signal,
            );
            const parsed =
                provider === "yandex"
                    ? z
                          .object({
                              tracks: z
                                  .object({
                                      results: z.array(z.unknown()).max(100),
                                  })
                                  .optional(),
                          })
                          .safeParse(data.result)
                    : z
                          .object({ items: z.array(z.unknown()).max(100) })
                          .safeParse(data.response);
            if (!parsed.success) throw new MusicSourceError("unavailable");
            const rows =
                "tracks" in parsed.data
                    ? (parsed.data.tracks?.results ?? [])
                    : "items" in parsed.data
                      ? parsed.data.items
                      : [];
            return rows
                .map((r) => normalize(provider, r))
                .filter((t): t is MusicSourceTrack => t !== null);
        },
        async lookup(trackId, signal) {
            assertId(provider, trackId);
            const data = await call(
                provider === "yandex"
                    ? `/tracks/${trackId}`
                    : `audio.getById?audios=${trackId}`,
                signal,
            );
            const parsed = z
                .array(z.unknown())
                .max(10)
                .safeParse(provider === "yandex" ? data.result : data.response);
            if (!parsed.success || !parsed.data.length) return null;
            const track = normalize(provider, parsed.data[0]);
            return track?.id === trackId ? track : null;
        },
        async open(trackId, request, signal) {
            assertId(provider, trackId);
            let media: string;
            if (provider === "vk") {
                const data = await call(
                    `audio.getById?audios=${trackId}`,
                    signal,
                );
                const parsed = z
                    .array(vkTrack)
                    .max(10)
                    .safeParse(data.response);
                const row = parsed.success
                    ? parsed.data.find(
                          (t) => `${t.owner_id}_${t.id}` === trackId,
                      )
                    : undefined;
                if (!row?.url || row.is_restricted)
                    throw new MusicSourceError("entitlement_required");
                media = row.url;
                if (new URL(media).pathname.endsWith(".m3u8"))
                    throw new MusicSourceError("unsupported_stream");
            } else {
                const data = await call(
                    `/tracks/${trackId}/download-info`,
                    signal,
                );
                const parsed = z
                    .array(
                        z.object({
                            codec: z.string(),
                            bitrateInKbps: z.number(),
                            preview: z.boolean(),
                            downloadInfoUrl: z.string(),
                        }),
                    )
                    .max(30)
                    .safeParse(data.result);
                const variant = parsed.success
                    ? parsed.data
                          .filter((t) => t.codec === "mp3" && !t.preview)
                          .sort((a, b) => b.bitrateInKbps - a.bitrateInKbps)[0]
                    : undefined;
                if (!variant)
                    throw new MusicSourceError("entitlement_required");
                if (!isMusicSourceUrlAllowed(variant.downloadInfoUrl, provider))
                    throw new MusicSourceError("unsupported_stream");
                const xml = await http.text(
                    variant.downloadInfoUrl,
                    provider,
                    signal,
                );
                if (xml.length > 8192 || /<!|&/.test(xml))
                    throw new MusicSourceError("unsupported_stream");
                const field = (name: string) => {
                    const matches = [
                        ...xml.matchAll(
                            new RegExp(`<${name}>([^<>]+)</${name}>`, "g"),
                        ),
                    ];
                    if (matches.length !== 1)
                        throw new MusicSourceError("unsupported_stream");
                    return matches[0][1];
                };
                const host = field("host"),
                    path = field("path"),
                    ts = field("ts"),
                    salt = field("s");
                if (
                    !/^[a-zA-Z0-9.-]+$/.test(host) ||
                    !/^\/[A-Za-z0-9_./%-]+$/.test(path) ||
                    !/^[a-fA-F0-9]{1,32}$/.test(ts) ||
                    !/^[A-Za-z0-9]+$/.test(salt)
                )
                    throw new MusicSourceError("unsupported_stream");
                const checksum = createHash("md5")
                    .update(`XGRlBW9FXlekgbPrRHuSiA${path.slice(1)}${salt}`)
                    .digest("hex");
                media = `https://${host}/get-mp3/${checksum}/${ts}${path}`;
            }
            if (!isMusicSourceUrlAllowed(media, provider))
                throw new MusicSourceError("unsupported_stream");
            return http.stream(media, provider, request, signal);
        },
    };
}
