import { redisClient } from "./redis";
import { DashboardSessions } from "./dashboardSessions";

/** Shared dashboard state; offline Redis commands fail within a bounded deadline. */
export const dashboardSessions = new DashboardSessions({
    get isReady() {
        return redisClient.isReady;
    },
    eval: (script, options) =>
        redisClient.sendCommand(
            [
                "EVAL",
                script,
                String(options.keys.length),
                ...options.keys,
                ...options.arguments,
            ],
            { timeout: 1500, abortSignal: AbortSignal.timeout(1500) },
        ),
});
