import { randomBytes } from "node:crypto";
import { matchesRecording } from "./matcher";
import { createMusicSourceUsage } from "./usage";
import {
    MusicSourceError,
    type MusicSourceAdapter,
    type MusicSource,
    type MusicSourceStream,
    type MusicStreamRequest,
    type RecordingRequest,
} from "./types";

interface Options {
    connections(): Promise<MusicSourceAdapter[]>;
    now?: () => number;
    maxStreams?: number;
}
interface Lease {
    userId: string;
    provider: MusicSource;
    trackId: string;
    version: number;
    expiresAt: number;
    validator: string;
    total: string;
}
function representation(response: MusicSourceStream) {
    const etag = response.headers.etag;
    const validator = etag?.startsWith('"')
        ? etag
        : response.headers["last-modified"];
    const total =
        response.status === 206
            ? /^bytes \d+-\d+\/(\d+)$/.exec(
                  response.headers["content-range"] ?? "",
              )?.[1]
            : response.headers["content-length"];
    if (
        !validator ||
        !total ||
        !Number.isSafeInteger(Number(total)) ||
        Number(total) <= 0
    )
        throw new MusicSourceError("unsupported_stream");
    return { validator, total };
}
async function readProbe(response: MusicSourceStream, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const dispose = () => {
            signal.removeEventListener("abort", abort);
            response.data.removeListener("data", data);
            response.data.removeListener("end", empty);
            response.data.removeListener("error", failure);
            response.data.on("error", () => {});
            response.data.destroy();
        };
        const data = (bytes: Buffer) => {
            if (bytes.length) {
                dispose();
                resolve();
            }
        };
        const empty = () => {
            dispose();
            reject(new MusicSourceError("unavailable"));
        };
        const failure = () => {
            dispose();
            reject(new MusicSourceError("unavailable"));
        };
        const abort = () => {
            dispose();
            reject(signal.reason);
        };
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
        response.data
            .once("end", empty)
            .once("error", failure)
            .on("data", data);
    });
}
/** Resolve exact recordings and own bounded, user-bound transport leases. */
export function createMusicSourceResolver(options: Options) {
    const now = options.now ?? Date.now;
    const usage = createMusicSourceUsage(now());
    const leases = new Map<string, Lease>();
    const circuits = new Map<string, { until: number; code: string }>();
    const active = new Map<string, number>();
    const controllers = new Map<MusicSource, Set<AbortController>>();
    let revision = 0;
    function lifetime(provider: MusicSource, parent: AbortSignal) {
        const controller = new AbortController();
        const group = controllers.get(provider) ?? new Set<AbortController>();
        group.add(controller);
        controllers.set(provider, group);
        return {
            signal: AbortSignal.any([parent, controller.signal]),
            dispose: () => {
                group.delete(controller);
                if (!group.size) controllers.delete(provider);
            },
        };
    }
    const keyOf = (source: MusicSourceAdapter) =>
        `${source.provider}:${source.version}`;
    const maxStreams = options.maxStreams ?? 8;
    let resolving = 0;
    function failed(key: string, error: unknown) {
        if (!(error instanceof MusicSourceError)) return;
        if (
            [
                "provider_challenge",
                "rate_limit",
                "auth_required",
                "entitlement_required",
            ].includes(error.code)
        ) {
            circuits.set(key, {
                until:
                    now() +
                    Math.max(30, Math.min(900, error.retryAfter)) * 1000,
                code: error.code,
            });
        }
    }
    const available = (source: MusicSourceAdapter) =>
        source.enabled && (circuits.get(keyOf(source))?.until ?? 0) <= now();
    function prune() {
        for (const [key, value] of leases)
            if (value.expiresAt <= now()) leases.delete(key);
        for (const [key, value] of circuits)
            if (value.until <= now()) circuits.delete(key);
    }
    return {
        async resolve(
            userId: string,
            wanted: RecordingRequest,
            signal: AbortSignal,
            provider?: MusicSource,
        ) {
            signal.throwIfAborted();
            prune();
            if (resolving >= 2 || leases.size >= 1000)
                throw new MusicSourceError("busy", 5);
            resolving++;
            try {
                const deadline = AbortSignal.any([
                    signal,
                    AbortSignal.timeout(16_000),
                ]);
                const generation = revision;
                const connections = await options.connections();
                if (generation !== revision)
                    throw new MusicSourceError("lease_expired");
                for (const source of connections) {
                    deadline.throwIfAborted();
                    if (
                        !available(source) ||
                        (provider && source.provider !== provider)
                    )
                        continue;
                    const operation = lifetime(source.provider, deadline);
                    usage.resolutionStarted(source.provider);
                    try {
                        const candidates = await source.search(
                            `${wanted.artists.join(" ")} ${wanted.title}`,
                            operation.signal,
                        );
                        operation.signal.throwIfAborted();
                        const matches = [
                            ...new Map(
                                candidates
                                    .filter(
                                        (c) =>
                                            c.provider === source.provider &&
                                            matchesRecording(wanted, c),
                                    )
                                    .map((c) => [c.id, c]),
                            ).values(),
                        ];
                        if (matches.length !== 1) {
                            usage.resolutionFinished(
                                source.provider,
                                "noMatch",
                            );
                            continue;
                        }
                        const candidate = matches[0];
                        const probe = await source.open(
                            candidate.id,
                            { range: "bytes=0-0" },
                            operation.signal,
                        );
                        let identity;
                        try {
                            if (probe.status !== 206)
                                throw new MusicSourceError(
                                    "unsupported_stream",
                                );
                            identity = representation(probe);
                            await readProbe(probe, operation.signal);
                        } finally {
                            probe.data.destroy();
                        }
                        operation.signal.throwIfAborted();
                        if (leases.size >= 1000)
                            throw new MusicSourceError("busy", 5);
                        const leaseId = randomBytes(24).toString("hex");
                        const expiresAt = now() + 3_600_000;
                        leases.set(leaseId, {
                            userId,
                            provider: source.provider,
                            trackId: candidate.id,
                            version: source.version,
                            expiresAt,
                            ...identity,
                        });
                        usage.resolutionFinished(source.provider, "selected");
                        return {
                            leaseId,
                            provider: source.provider,
                            expiresAt,
                            streamPath: `/api/music-sources/leases/${leaseId}/stream`,
                        };
                    } catch (error) {
                        usage.resolutionFinished(
                            source.provider,
                            signal.aborted ||
                                (operation.signal.aborted && !deadline.aborted)
                                ? "resolutionCancelled"
                                : "resolutionFailed",
                            error,
                        );
                        deadline.throwIfAborted();
                        failed(keyOf(source), error);
                    } finally {
                        operation.dispose();
                    }
                }
                return null;
            } finally {
                resolving--;
            }
        },
        async open(
            userId: string,
            leaseId: string,
            request: MusicStreamRequest,
            signal: AbortSignal,
        ) {
            signal.throwIfAborted();
            const lease = leases.get(leaseId);
            if (!lease || lease.userId !== userId)
                throw new MusicSourceError("not_found");
            if (lease.expiresAt <= now()) {
                leases.delete(leaseId);
                throw new MusicSourceError("lease_expired");
            }
            const generation = revision;
            const source = (await options.connections()).find(
                (s) =>
                    s.provider === lease.provider &&
                    s.enabled &&
                    s.version === lease.version,
            );
            if (generation !== revision)
                throw new MusicSourceError("lease_expired");
            if (!source) throw new MusicSourceError("lease_expired");
            const key = keyOf(source);
            if (!available(source) || (active.get(key) ?? 0) >= maxStreams)
                throw new MusicSourceError("busy", 5);
            signal.throwIfAborted();
            active.set(key, (active.get(key) ?? 0) + 1);
            const operation = lifetime(source.provider, signal);
            signal = operation.signal;
            let released = false;
            let outcomeRecorded = false;
            usage.streamStarted(source.provider);
            const recordOutcome = (
                outcome: "streamCompleted" | "streamFailed" | "streamCancelled",
                error?: unknown,
            ) => {
                if (outcomeRecorded) return;
                outcomeRecorded = true;
                usage.streamFinished(source.provider, outcome, error);
            };
            const release = () => {
                if (!released) {
                    released = true;
                    const remaining = (active.get(key) ?? 1) - 1;
                    if (remaining > 0) active.set(key, remaining);
                    else active.delete(key);
                    operation.dispose();
                }
            };
            try {
                const response = await source.open(
                    lease.trackId,
                    {
                        ...request,
                        ...(request.range ? { ifRange: lease.validator } : {}),
                    },
                    signal,
                );
                if (signal.aborted) {
                    response.data.destroy();
                    signal.throwIfAborted();
                }
                if (response.status !== 416) {
                    try {
                        const identity = representation(response);
                        if (
                            identity.validator !== lease.validator ||
                            identity.total !== lease.total
                        )
                            throw new MusicSourceError("lease_expired");
                    } catch (error) {
                        response.data.destroy();
                        throw error;
                    }
                }
                const abort = () => response.data.destroy();
                signal.addEventListener("abort", abort, { once: true });
                const done = (
                    outcome:
                        | "streamCompleted"
                        | "streamFailed"
                        | "streamCancelled",
                    error?: unknown,
                ) => {
                    recordOutcome(outcome, error);
                    signal.removeEventListener("abort", abort);
                    release();
                };
                response.data
                    .once("end", () => done("streamCompleted"))
                    .once("close", () =>
                        done(
                            signal.aborted
                                ? "streamCancelled"
                                : response.data.readableEnded
                                  ? "streamCompleted"
                                  : "streamFailed",
                        ),
                    )
                    .once("error", (error) =>
                        done(
                            signal.aborted ? "streamCancelled" : "streamFailed",
                            error,
                        ),
                    );
                if (response.data.destroyed || response.data.readableEnded)
                    done(
                        signal.aborted
                            ? "streamCancelled"
                            : response.data.readableEnded
                              ? "streamCompleted"
                              : "streamFailed",
                    );
                return response;
            } catch (error) {
                recordOutcome(
                    signal.aborted ? "streamCancelled" : "streamFailed",
                    error,
                );
                release();
                failed(key, error);
                throw error;
            }
        },
        revokeUser(userId: string) {
            for (const [id, lease] of leases)
                if (lease.userId === userId) leases.delete(id);
        },
        revokeProvider(provider: MusicSource) {
            revision++;
            for (const [id, lease] of leases)
                if (lease.provider === provider) leases.delete(id);
            for (const controller of controllers.get(provider) ?? [])
                controller.abort(new MusicSourceError("lease_expired"));
        },
        health() {
            prune();
            return {
                usage: usage.snapshot(),
                activeStreams: Object.fromEntries(active),
                circuits: [...circuits].map(([connection, state]) => ({
                    connection,
                    ...state,
                })),
                leases: leases.size,
            };
        },
    };
}
