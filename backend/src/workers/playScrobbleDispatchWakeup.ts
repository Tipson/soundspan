import Bull from "bull";
import { createIORedisClient } from "../utils/ioredis";
import { logger } from "../utils/logger";
import { scrobbleDispatchWakeSchema } from "../services/playScrobbleProtocol";

type Wake = { version: 1; dispatchId: string; userId: string };

/** One producer client per worker; unavailable Redis cannot delay a GC pass or startup. */
export function createPlayScrobbleWakeupProducer(
    queue: Pick<Bull.Queue, "add" | "close">,
    client: { status: string; disconnect(): void },
) {
    let stopped = false;
    return {
        async enqueue(wake: Wake) {
            if (stopped || client.status !== "ready")
                throw new Error("dispatch_wakeup_unavailable");
            const payload = scrobbleDispatchWakeSchema.parse(wake);
            return queue.add("dispatch-v1", payload, {
                attempts: 1,
                removeOnComplete: true,
                removeOnFail: 200,
            });
        },
        async close() {
            stopped = true;
            try {
                await queue.close(true);
            } finally {
                client.disconnect();
            }
        },
    };
}

/** Shares only the existing queue name; its short-lived commands cannot change legacy Redis behavior. */
export function createRuntimePlayScrobbleWakeupProducer() {
    const client = createIORedisClient("play-dispatch-wakeup", {
        commandTimeout: 2_000,
        connectTimeout: 2_000,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        enableReadyCheck: false,
    });
    const queue = new Bull("scrobble-forwarding", {
        createClient(type) {
            if (type !== "client")
                throw new Error("dispatch_wakeup_producer_only");
            return client;
        },
    });
    queue.on("error", () =>
        logger
            .child("PlayScrobbleDispatch")
            .warn("Dispatch wakeup Redis command failed"),
    );
    // Define Bull's Lua commands without waiting for a Redis connection.
    void queue.client;
    return createPlayScrobbleWakeupProducer(queue, client);
}
