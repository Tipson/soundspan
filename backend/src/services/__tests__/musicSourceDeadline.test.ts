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

    it("bounds a stalled connection read by the existing resolution deadline", async () => {
        const ready = source("vk");
        let complete!: (sources: MusicSourceAdapter[]) => void;
        const connections = new Promise<MusicSourceAdapter[]>((resolve) => {
            complete = resolve;
        });
        const resolver = createMusicSourceResolver({ connections: () => connections });
        let failure: unknown;
        const result = resolver.resolve("listener", recording, new AbortController().signal).catch(error => { failure = error; });
        try {
            await jest.advanceTimersByTimeAsync(16_000);
            expect(failure).toMatchObject({ name: "TimeoutError" });
            expect(resolver.health().leases).toBe(0);
        } finally {
            complete([ready]);
            await result;
        }
        expect(ready.search).not.toHaveBeenCalled();
    });

    it("cancels one waiter without cancelling or duplicating the shared connection read", async () => {
        const ready = source("vk");
        const completions: Array<(sources: MusicSourceAdapter[]) => void> = [];
        const connections = jest.fn(() => new Promise<MusicSourceAdapter[]>((resolve) => { completions.push(resolve); }));
        const resolver = createMusicSourceResolver({ connections });
        const cancelled = new AbortController();
        let failure: unknown;
        const first = resolver.resolve("first", recording, cancelled.signal).catch(error => { failure = error; });
        const second = resolver.resolve("second", recording, new AbortController().signal);
        await jest.advanceTimersByTimeAsync(0);
        cancelled.abort();
        await jest.advanceTimersByTimeAsync(0);
        try {
            expect(failure).toMatchObject({ name: "AbortError" });
            expect(connections).toHaveBeenCalledTimes(1);
        } finally {
            for (const complete of completions) complete([ready]);
        }
        await first;
        expect(await second).toMatchObject({ provider: "vk" });
        expect(ready.search).toHaveBeenCalledTimes(1);
        expect(resolver.health().leases).toBe(1);
    });

    it("cancels a stalled lease connection check before opening any stream", async () => {
        const ready = source("vk");
        let complete!: (sources: MusicSourceAdapter[]) => void;
        const connections = jest.fn().mockResolvedValueOnce([ready]).mockImplementationOnce(() => new Promise<MusicSourceAdapter[]>((resolve) => { complete = resolve; }));
        const resolver = createMusicSourceResolver({ connections });
        const lease = await resolver.resolve("listener", recording, new AbortController().signal);
        const cancelled = new AbortController();
        let failure: unknown;
        const stream = resolver.open("listener", lease!.leaseId, { range: "bytes=0-0" }, cancelled.signal).catch(error => { failure = error; });
        await jest.advanceTimersByTimeAsync(0);
        cancelled.abort();
        await jest.advanceTimersByTimeAsync(0);
        try {
            expect(failure).toMatchObject({ name: "AbortError" });
            expect(resolver.health().activeStreams).toEqual({});
        } finally {
            complete([ready]);
            await stream;
        }
        expect(ready.open).toHaveBeenCalledTimes(1); // Only the successful acquisition probe.
    });

    it("does not start extra database reads while timed-out callers wait for the same pending read", async () => {
        const ready = source("vk");
        let complete!: (sources: MusicSourceAdapter[]) => void;
        const pending = new Promise<MusicSourceAdapter[]>((resolve) => { complete = resolve; });
        const connections = jest.fn().mockReturnValueOnce(pending).mockResolvedValue([ready]);
        const resolver = createMusicSourceResolver({ connections });
        for (let i = 0; i < 4; i += 1) {
            const result = resolver.resolve("listener", recording, new AbortController().signal).catch(error => error);
            await jest.advanceTimersByTimeAsync(16_000);
            expect(await result).toMatchObject({ name: "TimeoutError" });
            expect(connections).toHaveBeenCalledTimes(1);
            expect(resolver.health().leases).toBe(0);
        }
        complete([ready]);
        await jest.advanceTimersByTimeAsync(0);
        expect(await resolver.resolve("listener", recording, new AbortController().signal)).toMatchObject({ provider: "vk" });
        expect(connections).toHaveBeenCalledTimes(2);
        expect(ready.search).toHaveBeenCalledTimes(1);
    });

    it("rejects an old pending configuration for waiters on either side of credential revocation", async () => {
        const ready = source("vk");
        let complete!: (sources: MusicSourceAdapter[]) => void;
        const pending = new Promise<MusicSourceAdapter[]>((resolve) => { complete = resolve; });
        const connections = jest.fn().mockReturnValueOnce(pending).mockResolvedValue([ready]);
        const resolver = createMusicSourceResolver({ connections });
        const first = resolver.resolve("first", recording, new AbortController().signal).catch(error => error);
        await jest.advanceTimersByTimeAsync(0);
        resolver.revokeProvider("vk");
        const second = resolver.resolve("second", recording, new AbortController().signal).catch(error => error);
        await jest.advanceTimersByTimeAsync(0);
        complete([ready]);
        expect(await first).toMatchObject({ code: "lease_expired" });
        expect(await second).toMatchObject({ code: "lease_expired" });
        expect(ready.search).not.toHaveBeenCalled();
        expect(resolver.health().leases).toBe(0);
        expect(await resolver.resolve("listener", recording, new AbortController().signal)).toMatchObject({ provider: "vk" });
        expect(connections).toHaveBeenCalledTimes(2);
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
