#!/usr/bin/env node

import http from "node:http";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const MAX_LISTENERS = 20;

function roundMetric(value) {
    return Math.round(value * 1_000) / 1_000;
}

function quantile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * fraction;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const lower = sorted[lowerIndex];
    const upper = sorted[upperIndex];
    return roundMetric(lower + (upper - lower) * (position - lowerIndex));
}

function summarizeMetric(samples, key) {
    const values = samples
        .map((sample) => sample[key])
        .filter((value) => Number.isFinite(value));
    return {
        p50: quantile(values, 0.5),
        p95: quantile(values, 0.95),
    };
}

/** Summarize successful client observations; errors are counted separately. */
export function summarizeLatencySamples(samples) {
    return {
        samples: samples.length,
        resolveMs: summarizeMetric(samples, "resolveMs"),
        firstByteMs: summarizeMetric(samples, "firstByteMs"),
        audibleGapMs: summarizeMetric(samples, "audibleGapMs"),
    };
}

/** Closed error taxonomy matching the bounded playback telemetry vocabulary. */
export function classifyPlaybackFailure({ status, errorName, errorCode } = {}) {
    if (status === 404 || status === 410 || status === 451) {
        return "unavailable";
    }
    if (status === 429) return "rate_limit";
    if (status === 408 || status === 504) return "timeout";
    if (errorName === "TimeoutError" || errorCode === "ETIMEDOUT") {
        return "timeout";
    }
    if (errorName === "AbortError") return "cancelled";
    if (
        errorCode === "ECONNRESET" ||
        errorCode === "ECONNREFUSED" ||
        errorCode === "ENETUNREACH"
    ) {
        return "network";
    }
    return "failed";
}

class PlaybackHttpError extends Error {
    constructor(status) {
        super(`Playback harness HTTP ${status}`);
        this.name = "PlaybackHttpError";
        this.status = status;
    }
}

function wait(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function singleFlight(map, key, task) {
    const existing = map.get(key);
    if (existing) return existing;
    const promise = task().finally(() => map.delete(key));
    map.set(key, promise);
    return promise;
}

async function createLoopbackMockProvider() {
    const warmResolveKeys = new Set();
    const warmStreamKeys = new Set();
    const resolveFlights = new Map();
    const streamFlights = new Map();
    const state = {
        activeRequests: 0,
        peakRequests: 0,
        concurrentResolveJobs: 0,
        concurrentStreamJobs: 0,
    };

    const server = http.createServer(async (request, response) => {
        state.activeRequests += 1;
        state.peakRequests = Math.max(state.peakRequests, state.activeRequests);
        try {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            const [, stage, scenario, encodedTrack] = url.pathname.split("/");
            const track = decodeURIComponent(encodedTrack ?? "missing");

            if (scenario === "unavailable") {
                response.writeHead(404).end();
                return;
            }
            if (scenario === "timeout") {
                await wait(100);
                if (!response.destroyed) response.writeHead(504).end();
                return;
            }
            if (stage !== "resolve" && stage !== "stream") {
                response.writeHead(404).end();
                return;
            }

            const isConcurrent = scenario === "concurrent";
            const flightMap =
                stage === "resolve" ? resolveFlights : streamFlights;
            const warmKeys =
                stage === "resolve" ? warmResolveKeys : warmStreamKeys;
            const key = `${stage}:${track}`;
            const execute = async () => {
                if (isConcurrent) {
                    if (stage === "resolve") state.concurrentResolveJobs += 1;
                    else state.concurrentStreamJobs += 1;
                }
                const isWarm = scenario === "warm" && warmKeys.has(track);
                const delayMs = isWarm ? 1 : stage === "resolve" ? 15 : 20;
                await wait(delayMs);
                warmKeys.add(track);
            };
            if (isConcurrent) await singleFlight(flightMap, key, execute);
            else await execute();
            if (response.destroyed) return;

            if (stage === "resolve") {
                response
                    .writeHead(200, { "content-type": "application/json" })
                    .end(
                        JSON.stringify({
                            streamPath: `/stream/${scenario}/${encodeURIComponent(track)}`,
                        }),
                    );
                return;
            }

            response.writeHead(200, {
                "content-type": "audio/mp4",
                "x-mock-audible-delay-ms": "3",
            });
            response.write(Buffer.from([0]));
            await wait(1);
            if (!response.destroyed) response.end(Buffer.from([1]));
        } catch {
            if (!response.headersSent) response.writeHead(500);
            if (!response.destroyed) response.end();
        } finally {
            state.activeRequests -= 1;
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("Loopback playback harness failed to bind");
    }
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        state,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function observePlaybackRequest({
    baseUrl,
    scenario,
    track,
    signal,
    timeoutMs = 1_000,
}) {
    const startedAt = performance.now();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
    const resolveResponse = await fetch(
        `${baseUrl}/resolve/${scenario}/${encodeURIComponent(track)}`,
        { signal: combinedSignal },
    );
    if (!resolveResponse.ok)
        throw new PlaybackHttpError(resolveResponse.status);
    const resolved = await resolveResponse.json();
    const resolveMs = performance.now() - startedAt;

    const streamStartedAt = performance.now();
    const streamResponse = await fetch(`${baseUrl}${resolved.streamPath}`, {
        signal: combinedSignal,
    });
    if (!streamResponse.ok) throw new PlaybackHttpError(streamResponse.status);
    const reader = streamResponse.body?.getReader();
    if (!reader) throw new Error("Playback response has no readable body");
    const firstChunk = await reader.read();
    if (firstChunk.done || !firstChunk.value?.byteLength) {
        throw new Error("Playback response ended before its first media byte");
    }
    const firstByteMs = performance.now() - streamStartedAt;
    const audibleDelayMs = Number(
        streamResponse.headers.get("x-mock-audible-delay-ms") ?? 0,
    );
    await wait(Number.isFinite(audibleDelayMs) ? audibleDelayMs : 0);
    const audibleGapMs = performance.now() - startedAt;
    await reader.cancel();
    return { resolveMs, firstByteMs, audibleGapMs };
}

function describeFailure(error) {
    return {
        status: error instanceof PlaybackHttpError ? error.status : undefined,
        errorName:
            error && typeof error === "object" && "name" in error
                ? String(error.name)
                : undefined,
        errorCode:
            error && typeof error === "object" && "code" in error
                ? String(error.code)
                : undefined,
    };
}

function summarizeSettled(results) {
    const samples = [];
    const errors = {};
    for (const result of results) {
        if (result.status === "fulfilled") {
            samples.push(result.value);
            continue;
        }
        const classification = classifyPlaybackFailure(
            describeFailure(result.reason),
        );
        errors[classification] = (errors[classification] ?? 0) + 1;
    }
    return {
        successes: samples.length,
        failures: results.length - samples.length,
        errors,
        latency: summarizeLatencySamples(samples),
    };
}

function captureSettlement(promise) {
    return promise.then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
    );
}

async function runBatch(baseUrl, scenario, tracks, options = {}) {
    return summarizeSettled(
        await Promise.allSettled(
            tracks.map((track) =>
                observePlaybackRequest({
                    baseUrl,
                    scenario,
                    track,
                    timeoutMs: options.timeoutMs,
                }),
            ),
        ),
    );
}

async function runRapidSkip(baseUrl, listeners) {
    const firstControllers = Array.from(
        { length: listeners },
        () => new AbortController(),
    );
    const first = firstControllers.map((controller, index) =>
        captureSettlement(
            observePlaybackRequest({
                baseUrl,
                scenario: "rapid",
                track: `listener-${index}-first`,
                signal: controller.signal,
            }),
        ),
    );
    await wait(2);
    firstControllers.forEach((controller) => controller.abort());

    const secondControllers = Array.from(
        { length: listeners },
        () => new AbortController(),
    );
    const second = secondControllers.map((controller, index) =>
        captureSettlement(
            observePlaybackRequest({
                baseUrl,
                scenario: "rapid",
                track: `listener-${index}-second`,
                signal: controller.signal,
            }),
        ),
    );
    await wait(2);
    secondControllers.forEach((controller) => controller.abort());

    const final = Array.from({ length: listeners }, (_, index) =>
        captureSettlement(
            observePlaybackRequest({
                baseUrl,
                scenario: "rapid",
                track: `listener-${index}-final`,
            }),
        ),
    );
    return summarizeSettled(await Promise.all([...first, ...second, ...final]));
}

/**
 * Run a deterministic, external-network-free load/fault baseline.
 * Latencies prove the harness plumbing only; they are not provider SLO data.
 */
export async function runMockPlaybackLoad({ listeners = 20 } = {}) {
    if (
        !Number.isInteger(listeners) ||
        listeners < 1 ||
        listeners > MAX_LISTENERS
    ) {
        throw new RangeError(
            `listeners must be between 1 and ${MAX_LISTENERS}`,
        );
    }
    const provider = await createLoopbackMockProvider();
    const listenerTracks = Array.from(
        { length: listeners },
        (_, index) => `listener-${index}`,
    );
    try {
        const coldStart = await runBatch(
            provider.baseUrl,
            "cold",
            listenerTracks,
        );
        const warmStart = await runBatch(
            provider.baseUrl,
            "warm",
            listenerTracks,
        );
        const concurrentListeners = await runBatch(
            provider.baseUrl,
            "concurrent",
            Array.from({ length: listeners }, () => "shared-track"),
        );
        const rapidSkip = await runRapidSkip(provider.baseUrl, listeners);
        const providerTimeout = await runBatch(
            provider.baseUrl,
            "timeout",
            listenerTracks,
            { timeoutMs: 25 },
        );
        const providerUnavailable = await runBatch(
            provider.baseUrl,
            "unavailable",
            listenerTracks,
        );
        return {
            mode: "loopback-mock",
            disclaimer:
                "Synthetic loopback timings validate the harness, not YouTube or production performance.",
            listeners,
            measurementDefinitions: {
                resolveMs:
                    "Resolve request start through its parsed JSON response.",
                firstByteMs:
                    "Stream request start through the first non-empty response body chunk.",
                audibleGapMs:
                    "Resolve start through first byte plus a synthetic mock decoder delay; real audible progress requires browser telemetry.",
            },
            scenarios: {
                coldStart,
                warmStart,
                concurrentListeners,
                rapidSkip,
                providerTimeout,
                providerUnavailable,
            },
            mockProvider: { ...provider.state },
        };
    } finally {
        await provider.close();
    }
}

function parseListeners(argv) {
    const argument = argv.find((value) => value.startsWith("--listeners="));
    return argument ? Number(argument.slice("--listeners=".length)) : 20;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    runMockPlaybackLoad({ listeners: parseListeners(process.argv.slice(2)) })
        .then((report) => {
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        })
        .catch((error) => {
            process.stderr.write(
                `${error instanceof Error ? error.message : error}\n`,
            );
            process.exitCode = 1;
        });
}
