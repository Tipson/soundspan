import { PassThrough, Readable } from "node:stream";
import { createMusicSourceResolver } from "../musicSources/resolver";
import type {
    MusicSourceAdapter,
    MusicSourceTrack,
} from "../musicSources/types";

const recording: MusicSourceTrack = {
    provider: "vk",
    id: "1_2",
    title: "Recording",
    artists: ["Artist"],
    duration: 180,
    contentVersion: "explicit",
    preview: false,
};
function source(provider: "vk" | "yandex"): MusicSourceAdapter {
    return {
        provider,
        version: 1,
        enabled: true,
        search: jest.fn(async () => [{ ...recording, provider }]),
        lookup: jest.fn(async () => ({ ...recording, provider })),
        open: jest.fn(async () => ({
            status: 206,
            headers: { etag: '"recording"', "content-range": "bytes 0-0/100" },
            data: Readable.from([Buffer.from("a")]),
        })),
    };
}
function waitForAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
        });
    });
}

describe("music source resolution time budget", () => {
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
        // Native AbortSignal timers are outside Jest's clock; preserve abort semantics.
        jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
            const controller = new AbortController();
            setTimeout(
                () =>
                    controller.abort(
                        new DOMException("Timed out", "TimeoutError"),
                    ),
                ms,
            );
            return controller.signal;
        });
    });
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it.each(["search", "probe"] as const)(
        "tries the healthy backup when the first source stalls during %s",
        async (stage) => {
            const first = source("vk"),
                backup = source("yandex");
            const stalledBody = new PassThrough();
            if (stage === "search")
                first.search = jest.fn((_query, signal) =>
                    waitForAbort(signal),
                );
            else
                first.open = jest.fn(async () => ({
                    status: 206,
                    headers: {
                        etag: '"recording"',
                        "content-range": "bytes 0-0/100",
                    },
                    data: stalledBody,
                }));
            const resolver = createMusicSourceResolver({
                connections: async () => [first, backup],
            });
            const result = resolver.resolve(
                "listener",
                recording,
                new AbortController().signal,
            );
            const assertion = expect(result).resolves.toMatchObject({
                provider: "yandex",
            });
            await jest.advanceTimersByTimeAsync(16000);
            await assertion;
            expect(backup.search).toHaveBeenCalledTimes(1);
            if (stage === "probe") expect(stalledBody.destroyed).toBe(true);
            expect(resolver.health().usage.providers.vk).toMatchObject({
                resolutionFailed: 1,
                resolutionCancelled: 0,
            });
            expect(resolver.health().circuits).toEqual([]);
        },
    );

    it("does not try the backup after listener cancellation", async () => {
        const first = source("vk"),
            backup = source("yandex");
        first.search = jest.fn((_query, signal) => waitForAbort(signal));
        const controller = new AbortController();
        const resolver = createMusicSourceResolver({
            connections: async () => [first, backup],
        });
        const result = resolver.resolve(
            "listener",
            recording,
            controller.signal,
        );
        const assertion = expect(result).rejects.toMatchObject({
            name: "AbortError",
        });
        await jest.advanceTimersByTimeAsync(1000);
        controller.abort();
        await assertion;
        await jest.advanceTimersByTimeAsync(16000);
        expect(backup.search).not.toHaveBeenCalled();
        expect(resolver.health().leases).toBe(0);
    });

    it("gives a single selected provider the full budget", async () => {
        const first = source("vk"),
            chosen = source("yandex");
        chosen.search = jest.fn(async (_query, signal) => {
            await new Promise((resolve) => setTimeout(resolve, 12000));
            signal.throwIfAborted();
            return [{ ...recording, provider: "yandex" as const }];
        });
        const resolver = createMusicSourceResolver({
            connections: async () => [first, chosen],
        });
        const result = resolver.resolve(
            "listener",
            recording,
            new AbortController().signal,
            "yandex",
        );
        const assertion = expect(result).resolves.toMatchObject({
            provider: "yandex",
        });
        await jest.advanceTimersByTimeAsync(12000);
        await assertion;
        expect(first.search).not.toHaveBeenCalled();
    });

    it("keeps the total deadline when both providers stall", async () => {
        const first = source("vk"),
            backup = source("yandex");
        first.search = jest.fn((_query, signal) => waitForAbort(signal));
        backup.search = jest.fn((_query, signal) => waitForAbort(signal));
        const resolver = createMusicSourceResolver({
            connections: async () => [first, backup],
        });
        const result = resolver
            .resolve("listener", recording, new AbortController().signal)
            .then(
                () => ({ rejected: false }),
                () => ({ rejected: true }),
            );
        await jest.advanceTimersByTimeAsync(16000);
        expect(await result).toEqual({ rejected: true });
        expect(backup.search).toHaveBeenCalledTimes(1);
        expect(resolver.health().leases).toBe(0);
    });

    it("preserves cancellation while the second provider is resolving", async () => {
        const first = source("vk"),
            backup = source("yandex");
        first.search = jest.fn((_query, signal) => waitForAbort(signal));
        backup.search = jest.fn((_query, signal) => waitForAbort(signal));
        const controller = new AbortController();
        const resolver = createMusicSourceResolver({
            connections: async () => [first, backup],
        });
        const result = resolver
            .resolve("listener", recording, controller.signal)
            .then(
                () => null,
                (error) => error,
            );
        await jest.advanceTimersByTimeAsync(9000);
        controller.abort();
        expect(await result).toMatchObject({ name: "AbortError" });
        expect(
            resolver.health().usage.providers.yandex.resolutionCancelled,
        ).toBe(1);
        expect(resolver.health().leases).toBe(0);
    });

    it("does not expire a successful lease when the acquisition timer would have fired", async () => {
        const first = source("vk"),
            backup = source("yandex");
        const resolver = createMusicSourceResolver({
            connections: async () => [first, backup],
        });
        const lease = await resolver.resolve(
            "listener",
            recording,
            new AbortController().signal,
        );
        await jest.advanceTimersByTimeAsync(20000);
        const stream = await resolver.open(
            "listener",
            lease!.leaseId,
            { range: "bytes=0-0" },
            new AbortController().signal,
        );
        expect(stream.status).toBe(206);
        stream.data.destroy();
        expect(backup.search).not.toHaveBeenCalled();
    });
});
