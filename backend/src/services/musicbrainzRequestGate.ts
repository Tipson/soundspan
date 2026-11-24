/** Shared dispatch pacing and provider cooldown for every MusicBrainz HTTP call. */
import { redisClient } from "../utils/redis";

const KEY = "soundspan:musicbrainz:dispatch:v1";
const INTERVAL_MS = 1_100;
const ADMISSION_BUDGET_MS = 2_500;
const REDIS_BUDGET_MS = 500;
const RESERVATION_MS = INTERVAL_MS + REDIS_BUDGET_MS;
const MIN_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const RESERVE = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then return ttl end
redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
return 0
`;
const COOLDOWN = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl < tonumber(ARGV[1]) then
    redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
end
return 0
`;

function deferred(): Error {
    // Optional metadata defers to its cache/fallback. Do not classify gate
    // pressure as another upstream HTTP failure and retry it in the limiter.
    return new Error("MusicBrainz shared request admission deferred");
}

function cooldownDelay(retryAfter: unknown): number {
    const value =
        typeof retryAfter === "string" || typeof retryAfter === "number"
            ? String(retryAfter).trim()
            : "";
    const delay = /^\d+$/.test(value)
        ? Number(value) * 1_000
        : Date.parse(value) - Date.now();
    // Honor both HTTP forms without letting malformed upstream guidance hold
    // optional metadata indefinitely. Callers still defer within their budget.
    return Number.isSafeInteger(delay) && delay >= 0
        ? Math.max(MIN_COOLDOWN_MS, Math.min(MAX_COOLDOWN_MS, delay))
        : MIN_COOLDOWN_MS;
}

async function command(script: string, delayMs: number): Promise<number> {
    if (!redisClient.isReady) throw deferred();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            redisClient.withAbortSignal(controller.signal).eval(script, {
                keys: [KEY],
                arguments: [String(delayMs)],
            }),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(deferred());
                }, REDIS_BUDGET_MS);
            }),
        ]);
        if (typeof result !== "number" || result < 0) throw deferred();
        return result;
    } catch {
        throw deferred();
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

/** Pace API and worker HTTP calls together; defer instead of building an unbounded queue. */
export async function runMusicBrainzRequest<T>(
    request: () => Promise<T>,
): Promise<T> {
    const deadline = Date.now() + ADMISSION_BUDGET_MS;
    while (true) {
        if (Date.now() >= deadline) throw deferred();
        const requestedAt = Date.now();
        const waitMs = await command(RESERVE, RESERVATION_MS);
        if (Date.now() >= deadline) throw deferred();
        if (waitMs === 0) {
            // Redis starts the lease before its reply reaches this process.
            // Never spend another caller's one-second spacing on a late reply.
            if (Date.now() - requestedAt >= REDIS_BUDGET_MS) throw deferred();
            break;
        }
        if (waitMs >= deadline - Date.now()) throw deferred();
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    try {
        return await request();
    } catch (error) {
        const failure = error as {
            code?: string;
            response?: {
                status?: number;
                headers?: Record<string, unknown>;
            };
        } | null;
        const response = failure?.response;
        if (
            response?.status === 429 ||
            response?.status === 503 ||
            failure?.code === "ECONNRESET"
        ) {
            // A TLS/socket reset affects API and worker callers together too;
            // do not let their individual retry loops amplify the same outage.
            const delay = cooldownDelay(response?.headers?.["retry-after"]);
            // The caller still receives the original provider failure if Redis
            // also becomes unavailable; no signed URL or credentials are logged.
            await command(COOLDOWN, delay).catch(() => undefined);
        }
        throw error;
    }
}
