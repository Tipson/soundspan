import { createMusicSourceFallback } from "../musicSources/fallback";
const recording = {
    title: "Song",
    artists: ["Artist"],
    duration: 180,
    contentVersion: "unknown" as const,
};
const failure = { response: { status: 503 } };
const sessionId = "11111111-1111-4111-8111-111111111111";
const input = () => ({
    userId: "a",
    videoId: "jNQXAC9IVRw",
    sessionId,
    range: "bytes=0-",
    signal: new AbortController().signal,
    original: jest.fn(async (): Promise<string> => {
        throw failure;
    }),
});
describe("transparent provider fallback", () => {
    it("keeps acquired audio alive beyond the startup deadline and still forwards listener cancellation", async () => {
        const controller = new AbortController();
        let upstream: AbortSignal | undefined;
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve: async () => null,
            primaryTimeoutMs: 10,
        });
        expect(
            await fallback.acquire({
                ...input(),
                signal: controller.signal,
                original: async (signal) => {
                    upstream = signal;
                    return "playing";
                },
            }),
        ).toEqual({ stream: "playing" });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(upstream?.aborted).toBe(false);
        controller.abort();
        expect(upstream?.aborted).toBe(true);
    });
    it.each(["ECONNABORTED", "ECONNREFUSED", "ETIMEDOUT"])(
        "recovers an initial transport failure %s",
        async (code) => {
            const fallback = createMusicSourceFallback({
                recording: async () => recording,
                resolve: async () => ({ streamPath: "/alternate" }),
            });
            expect(
                await fallback.acquire({
                    ...input(),
                    original: async () => {
                        throw { code };
                    },
                }),
            ).toEqual({ redirect: "/alternate" });
        },
    );
    it("reserves time for an alternate instead of exhausting the frontend deadline", async () => {
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve: async () => ({ streamPath: "/alternate" }),
            primaryTimeoutMs: 10,
        });
        const result = await fallback.acquire({
            ...input(),
            original: (signal: AbortSignal) =>
                new Promise<string>((_, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(signal.reason),
                        { once: true },
                    );
                }),
        });
        expect(result).toEqual({ redirect: "/alternate" });
    });
    it("preserves the original signal and error when no alternate is configured", async () => {
        const resolve = jest.fn();
        const first = input();
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve,
            enabled: async () => false,
        });
        const original = jest.fn(
            async (signal: AbortSignal): Promise<string> => {
                expect(signal).toBe(first.signal);
                throw failure;
            },
        );
        await expect(fallback.acquire({ ...first, original })).rejects.toEqual(
            failure,
        );
        expect(resolve).not.toHaveBeenCalled();
    });
    it("redirects an initial upstream failure to an owned lease and keeps seek on that lease", async () => {
        const resolve = jest.fn(async () => ({
            streamPath: "/api/music-sources/leases/abc/stream",
        }));
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve,
        });
        const first = input();
        expect(await fallback.acquire(first)).toEqual({
            redirect: "/api/music-sources/leases/abc/stream",
        });
        const seek = { ...input(), range: "bytes=100-" };
        expect(await fallback.acquire(seek)).toEqual({
            redirect: "/api/music-sources/leases/abc/stream",
        });
        expect(seek.original).not.toHaveBeenCalled();
        expect(resolve).toHaveBeenCalledTimes(1);
    });
    it("does not change representation after any original stream was acquired", async () => {
        const resolve = jest.fn();
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve,
        });
        expect(
            await fallback.acquire({
                ...input(),
                original: async () => "yt-bytes",
            }),
        ).toEqual({ stream: "yt-bytes" });
        await expect(fallback.acquire(input())).rejects.toEqual(failure);
        expect(resolve).not.toHaveBeenCalled();
    });
    it("never switches a legacy or uncorrelated byte-range request", async () => {
        const resolve = jest.fn();
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve,
        });
        await expect(
            fallback.acquire({ ...input(), sessionId: undefined }),
        ).rejects.toEqual(failure);
        await expect(
            fallback.acquire({ ...input(), range: "bytes=123-" }),
        ).rejects.toEqual(failure);
        expect(resolve).not.toHaveBeenCalled();
    });
    it("does not share bindings between users or playback sessions", async () => {
        const resolve = jest.fn(async (user: string) => ({
            streamPath: `/api/music-sources/leases/${user}/stream`,
        }));
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve,
        });
        await fallback.acquire(input());
        expect(await fallback.acquire({ ...input(), userId: "b" })).toEqual({
            redirect: "/api/music-sources/leases/b/stream",
        });
        expect(resolve).toHaveBeenCalledTimes(2);
    });
    it("does not use another provider to bypass age verification", async () => {
        const resolve = jest.fn();
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve,
        });
        await expect(
            fallback.acquire({
                ...input(),
                original: async () => {
                    throw { response: { status: 451 } };
                },
            }),
        ).rejects.toBeDefined();
        expect(resolve).not.toHaveBeenCalled();
    });
});
