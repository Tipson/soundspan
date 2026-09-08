import { setTimeout as delay } from "node:timers/promises";
import axios from "axios";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { RecordingLanguageStore } from "./recordingLanguageStore";
import { languageCacheKey, parseLanguageCache } from "./recordingLanguage";
import { lookupRecordingLanguage } from "./recordingLanguageProvider";

const log = logger.child("RecordingLanguage");
const BACKOFF_KEY = "wave:language:provider-backoff";
function cache() {
    if (!redisClient.isReady) throw new Error("Language cache unavailable");
    return redisClient.withCommandOptions({
        abortSignal: AbortSignal.timeout(500),
    });
}

/** Shared classifications, bounded optional fills; cache outages never cause provider fan-out. */
export const recordingLanguageStore = new RecordingLanguageStore({
    read: async (keys) =>
        keys.length ? (await cache().mGet(keys)).map(parseLanguageCache) : [],
    fill: async (track) => {
        const key = languageCacheKey(track);
        if (
            (await cache().get(key)) ||
            (await cache().get(`${key}:retry`)) ||
            (await cache().get(BACKOFF_KEY))
        )
            return;
        // Keep concurrent API processes from looking up the same recording.
        if (!(await cache().set(`${key}:lock`, "1", { NX: true, EX: 30 })))
            return;
        // At most one metadata lookup per second across processes. Missed slots
        // are deferred to a later Wave request, never spun/retried in a loop.
        await delay(1050, undefined, { ref: false });
        if (
            !(await cache().set("wave:language:lookup-slot", "1", {
                NX: true,
                EX: 1,
            }))
        )
            return;
        try {
            const language = await lookupRecordingLanguage(track);
            await cache().set(key, language, {
                EX: language === "unknown" ? 24 * 60 * 60 : 30 * 24 * 60 * 60,
            });
        } catch (error) {
            // A slow/missing recording is not a provider-wide outage. Keep its
            // retry separate so other personalized songs can still be classified.
            await cache().set(`${key}:retry`, "1", { EX: 120 });
            const status = axios.isAxiosError(error)
                ? error.response?.status
                : undefined;
            if (status === 429 || (status !== undefined && status >= 500)) {
                await cache().set(BACKOFF_KEY, "1", { EX: 120 });
            }
            throw error;
        }
    },
    warn: (error) =>
        log.debug("Optional language preparation unavailable", {
            error: error instanceof Error ? error.message : "unknown",
        }),
});
