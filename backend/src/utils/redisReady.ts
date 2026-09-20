import type { EventEmitter } from "node:events";

/** Wait once for ioredis readiness before registering a batch of Bull handlers. */
export function waitForRedisReady(
    client: EventEmitter & { status: string },
    timeoutMs = 30_000,
): Promise<void> {
    if (client.status === "ready") return Promise.resolve();
    if (client.status === "end")
        return Promise.reject(new Error("Redis connection ended"));
    return new Promise((resolve, reject) => {
        let lastError: unknown;
        const cleanup = () => {
            clearTimeout(timer);
            client.removeListener("ready", ready);
            client.removeListener("end", ended);
            client.removeListener("error", error);
        };
        const ready = () => {
            cleanup();
            resolve();
        };
        const ended = () => {
            cleanup();
            reject(lastError ?? new Error("Redis connection ended"));
        };
        const error = (value: unknown) => {
            lastError = value;
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Redis readiness timed out"));
        }, timeoutMs);
        timer.unref();
        client.once("ready", ready);
        client.once("end", ended);
        client.on("error", error);
    });
}
