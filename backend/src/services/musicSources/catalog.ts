import { z } from "zod";
import {
    MusicSourceError,
    type MusicSource,
    type MusicSourceAdapter,
    type MusicSourceTrack,
} from "./types";

const candidateSchema = z.object({
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
interface Options {
    connections(): Promise<MusicSourceAdapter[]>;
    now?: () => number;
    concurrency?: number;
    timeoutMs?: number;
}
/** Sanitized partial results; unavailable catalogs must not be presented as exhausted. */
export interface MusicSourceCatalogResult {
    tracks: MusicSourceTrack[];
    unavailable: MusicSource[];
}

/** Bounded catalog fan-out, independently cached and fenced by service credential generation. */
export function createMusicSourceCatalog(options: Options) {
    const now = options.now ?? Date.now;
    const active = new Map<MusicSource, number>();
    const cooldowns = new Map<string, number>();
    const cache = new Map<
        string,
        { until: number; tracks: MusicSourceTrack[] }
    >();
    type Operation =
        | { kind: "search"; text: string; limit: 20 }
        | {
              kind: "recommendations";
              provider: MusicSource;
              id: string;
              limit: number;
          };
    const copy = (tracks: MusicSourceTrack[]) =>
        tracks.map((track) => ({ ...track, artists: [...track.artists] }));
    const run = async (
        operation: Operation,
        parent: AbortSignal,
    ): Promise<MusicSourceCatalogResult> => {
        parent.throwIfAborted();
        const allSources = (await options.connections()).filter(
            (source) => source.enabled,
        );
        parent.throwIfAborted();
        const generations = new Set(
            allSources.map((s) => `${s.provider}:${s.version}`),
        );
        for (const [key, value] of cache)
            if (value.until <= now() || !generations.has(key.split("|")[0]))
                cache.delete(key);
        for (const [key, until] of cooldowns)
            if (until <= now() || !generations.has(key)) cooldowns.delete(key);

        const sources =
            operation.kind === "search"
                ? allSources
                : allSources.filter(
                      (source) => source.provider === operation.provider,
                  );
        const results = await Promise.all(
            sources.map(async (source) => {
                const generation = `${source.provider}:${source.version}`;
                const key =
                    operation.kind === "search"
                        ? `${generation}|search|${operation.text.normalize("NFKC").toLowerCase()}`
                        : `${generation}|recommendations|${operation.id}|${operation.limit}`;
                if (
                    operation.kind === "recommendations" &&
                    !source.recommendations
                )
                    return {
                        tracks: [],
                        unavailable: true,
                        source,
                        generation,
                        key,
                    };
                const cached = cache.get(key);
                if (cached)
                    return {
                        tracks: copy(cached.tracks),
                        unavailable: false,
                        source,
                        generation,
                        key,
                    };
                if (
                    (cooldowns.get(generation) ?? 0) > now() ||
                    (active.get(source.provider) ?? 0) >=
                        (options.concurrency ?? 2)
                )
                    return {
                        tracks: [],
                        unavailable: true,
                        source,
                        generation,
                        key,
                    };
                const timeout = new AbortController();
                const signal = AbortSignal.any([parent, timeout.signal]);
                const timer = setTimeout(
                    () => timeout.abort(),
                    options.timeoutMs ?? 4000,
                ).unref();
                let abort = () => {};
                const cancelled = new Promise<never>((_, reject) => {
                    abort = () => reject(signal.reason);
                    if (signal.aborted) abort();
                    else
                        signal.addEventListener("abort", abort, {
                            once: true,
                        });
                });
                active.set(
                    source.provider,
                    (active.get(source.provider) ?? 0) + 1,
                );
                // A non-cooperative adapter keeps its slot until it actually stops.
                const work = Promise.resolve()
                    .then(() => {
                        signal.throwIfAborted();
                        return operation.kind === "search"
                            ? source.search(operation.text, signal)
                            : source.recommendations!(
                                  operation.id,
                                  operation.limit,
                                  signal,
                              );
                    })
                    .finally(() => {
                        const remaining =
                            (active.get(source.provider) ?? 1) - 1;
                        if (remaining) active.set(source.provider, remaining);
                        else active.delete(source.provider);
                    });
                try {
                    const rows = await Promise.race([work, cancelled]);
                    signal.throwIfAborted();
                    const unique = new Map<string, MusicSourceTrack>();
                    for (const row of rows.slice(0, 100)) {
                        const parsed = candidateSchema.safeParse(row);
                        if (
                            !parsed.success ||
                            parsed.data.provider !== source.provider
                        )
                            continue;
                        const id = parsed.data.id;
                        if (
                            !(
                                source.provider === "vk"
                                    ? /^-?\d{1,20}_\d{1,20}$/
                                    : /^\d{1,20}$/
                            ).test(id)
                        )
                            continue;
                        unique.set(id, parsed.data);
                    }
                    const tracks = [...unique.values()].slice(
                        0,
                        operation.limit,
                    );
                    return {
                        tracks,
                        unavailable: false,
                        source,
                        generation,
                        key,
                    };
                } catch (error) {
                    parent.throwIfAborted();
                    if (
                        error instanceof MusicSourceError &&
                        [
                            "provider_challenge",
                            "rate_limit",
                            "auth_required",
                            "entitlement_required",
                        ].includes(error.code)
                    )
                        cooldowns.set(
                            generation,
                            now() +
                                Math.max(30, Math.min(900, error.retryAfter)) *
                                    1000,
                        );
                    return {
                        tracks: [],
                        unavailable: true,
                        source,
                        generation,
                        key,
                    };
                } finally {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", abort);
                }
            }),
        );
        const current = new Set(
            (await options.connections())
                .filter((s) => s.enabled)
                .map((s) => `${s.provider}:${s.version}`),
        );
        const accepted = results.filter((r) => current.has(r.generation));
        parent.throwIfAborted();
        for (const result of accepted) {
            if (result.unavailable || cache.has(result.key)) continue;
            if (cache.size >= 100) cache.delete(cache.keys().next().value!);
            cache.set(result.key, {
                until: now() + 60_000,
                tracks: copy(result.tracks),
            });
        }
        return {
            tracks: copy(accepted.flatMap((r) => r.tracks)),
            unavailable:
                operation.kind === "recommendations" &&
                (!accepted.length || accepted.some((r) => r.unavailable))
                    ? [operation.provider]
                    : accepted
                          .filter((r) => r.unavailable)
                          .map((r) => r.source.provider),
        };
    };
    return {
        async search(
            query: string,
            parent: AbortSignal,
        ): Promise<MusicSourceCatalogResult> {
            parent.throwIfAborted();
            const text = query.trim();
            if (!text || text.length > 200)
                throw new MusicSourceError("invalid_request");
            return run({ kind: "search", text, limit: 20 }, parent);
        },
        /** Bounded exact-source neighbours sharing search slots, backoff and generation fences. */
        async recommendations(
            provider: MusicSource,
            id: string,
            limit: number,
            parent: AbortSignal,
        ): Promise<MusicSourceCatalogResult> {
            parent.throwIfAborted();
            if (
                !["vk", "yandex"].includes(provider) ||
                typeof id !== "string" ||
                !(
                    provider === "vk" ? /^-?\d{1,20}_\d{1,20}$/ : /^\d{1,20}$/
                ).test(id) ||
                !Number.isInteger(limit) ||
                limit < 1 ||
                limit > 100
            )
                throw new MusicSourceError("invalid_request");
            return run(
                { kind: "recommendations", provider, id, limit },
                parent,
            );
        },
    };
}
