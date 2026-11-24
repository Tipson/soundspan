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
    it("recovers and pins a mobile base64url playback attempt across byte-range retries", async () => {
        const resolve = jest.fn(async () => ({ streamPath: "/alternate" }));
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve,
        });
        const mobile = {
            ...input(),
            sessionId: Buffer.alloc(24, 251).toString("base64url"),
        };
        await expect(fallback.acquire(mobile)).resolves.toEqual({
            redirect: "/alternate",
        });
        await expect(
            fallback.acquire({ ...mobile, range: "bytes=2048-" }),
        ).resolves.toEqual({ redirect: "/alternate" });
        expect(resolve).toHaveBeenCalledTimes(1);

        await fallback.acquire({
            ...mobile,
            sessionId: Buffer.alloc(24, 252).toString("base64url"),
        });
        expect(resolve).toHaveBeenCalledTimes(2);
    });
    it.each(["a".repeat(31), "a".repeat(33), ":".repeat(32), "../".repeat(11)])(
        "does not correlate an invalid mobile playback session %s",
        async (sessionId) => {
            const resolve = jest.fn();
            const fallback = createMusicSourceFallback({
                recording: async () => recording,
                resolve,
            });
            await expect(
                fallback.acquire({ ...input(), sessionId }),
            ).rejects.toEqual(failure);
            expect(resolve).not.toHaveBeenCalled();
        },
    );
    it.each([404, 429, 500, 502, 503, 504])(
        "recovers upstream HTTP %s before audio starts",
        async (status) => {
            const resolve = jest.fn(async () => ({ streamPath: "/alternate" }));
            const fallback = createMusicSourceFallback({
                recording: async () => recording,
                resolve,
            });
            await expect(
                fallback.acquire({
                    ...input(),
                    original: async () => {
                        throw { response: { status } };
                    },
                }),
            ).resolves.toEqual({ redirect: "/alternate" });
            expect(resolve).toHaveBeenCalledWith(
                "a",
                recording,
                expect.any(AbortSignal),
            );
        },
    );
    it.each([400, 401, 403, 451])(
        "preserves explicit HTTP %s restrictions",
        async (status) => {
            const resolve = jest.fn();
            const fallback = createMusicSourceFallback({
                recording: async () => recording,
                resolve,
            });
            const error = { response: { status } };
            await expect(
                fallback.acquire({
                    ...input(),
                    original: async () => {
                        throw error;
                    },
                }),
            ).rejects.toEqual(error);
            expect(resolve).not.toHaveBeenCalled();
        },
    );
    it("does not pin a late alternate after the listener cancels", async () => {
        const controller = new AbortController();
        const reason = new Error("listener switched tracks");
        const resolve = jest.fn(async () => {
            controller.abort(reason);
            return { streamPath: "/stale" };
        });
        const fallback = createMusicSourceFallback({
            recording: async () => recording,
            resolve,
        });
        await expect(
            fallback.acquire({ ...input(), signal: controller.signal }),
        ).rejects.toBe(reason);
        resolve.mockResolvedValueOnce({ streamPath: "/fresh" });
        await expect(fallback.acquire(input())).resolves.toEqual({
            redirect: "/fresh",
        });
        expect(resolve).toHaveBeenCalledTimes(2);
    });
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

    describe("initial connection budget", () => {
        const delayedAudio = (
            signal: AbortSignal,
            ms: number,
            value = "playing",
        ): Promise<string> =>
            new Promise((finish, reject) => {
                const timer = setTimeout(() => finish(value), ms);
                signal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        reject(signal.reason);
                    },
                    { once: true },
                );
            });
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => {
            jest.clearAllTimers();
            jest.useRealTimers();
        });

        it("starts an exact alternate after six seconds of pending initial audio", async () => {
            const resolve = jest.fn(async () => ({ streamPath: "/alternate" }));
            const fallback = createMusicSourceFallback({
                enabled: async () => true,
                recording: async () => recording,
                resolve,
            });
            let upstream: AbortSignal | undefined;
            const pending = fallback.acquire({
                ...input(),
                original: (signal: AbortSignal) => {
                    upstream = signal;
                    return new Promise<string>((_, reject) => {
                        signal.addEventListener(
                            "abort",
                            () => reject(signal.reason),
                            { once: true },
                        );
                    });
                },
            });
            await jest.advanceTimersByTimeAsync(5_999);
            expect(upstream?.aborted).toBe(false);
            expect(resolve).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(1);
            expect(upstream?.aborted).toBe(true);
            expect(resolve).toHaveBeenCalledTimes(1);
            await expect(pending).resolves.toEqual({ redirect: "/alternate" });
        });

        it("keeps acquired audio alive after the initial budget and preserves listener cancellation", async () => {
            const controller = new AbortController();
            const resolve = jest.fn();
            const fallback = createMusicSourceFallback({
                enabled: async () => true,
                recording: async () => recording,
                resolve,
            });
            let upstream: AbortSignal | undefined;
            const pending = fallback.acquire({
                ...input(),
                signal: controller.signal,
                original: (signal: AbortSignal) => {
                    upstream = signal;
                    return new Promise<string>((finish) => {
                        setTimeout(() => finish("playing"), 2_500);
                    });
                },
            });
            await jest.advanceTimersByTimeAsync(2_500);
            await expect(pending).resolves.toEqual({ stream: "playing" });
            await jest.advanceTimersByTimeAsync(3_500);
            expect(upstream?.aborted).toBe(false);
            expect(resolve).not.toHaveBeenCalled();

            controller.abort();
            expect(upstream?.aborted).toBe(true);
        });

        it("does not start an alternate when the listener cancels before the initial budget", async () => {
            const controller = new AbortController();
            const reason = new Error("listener switched tracks");
            const resolve = jest.fn(async () => ({ streamPath: "/alternate" }));
            const fallback = createMusicSourceFallback({
                enabled: async () => true,
                recording: async () => recording,
                resolve,
            });
            const pending = fallback.acquire({
                ...input(),
                signal: controller.signal,
                original: (signal: AbortSignal) =>
                    new Promise<string>((_, reject) => {
                        signal.addEventListener(
                            "abort",
                            () => reject(signal.reason),
                            { once: true },
                        );
                    }),
            });
            const cancelled = expect(pending).rejects.toBe(reason);
            await jest.advanceTimersByTimeAsync(5_999);
            controller.abort(reason);
            await cancelled;
            await jest.advanceTimersByTimeAsync(1);
            expect(resolve).not.toHaveBeenCalled();
        });

        it.each(["no_match", "resolve_failed", "recording_failed"] as const)(
            "preserves a slow valid original when the early alternate ends with %s",
            async (outcome) => {
                const resolve = jest.fn(async () => {
                    if (outcome === "resolve_failed")
                        throw new Error("alternate unavailable");
                    return null;
                });
                const fallback = createMusicSourceFallback({
                    enabled: async () => true,
                    recording: async () => {
                        if (outcome === "recording_failed")
                            throw new Error("metadata unavailable");
                        return recording;
                    },
                    resolve,
                });
                let upstream: AbortSignal | undefined;
                const pending = fallback
                    .acquire({
                        ...input(),
                        original: (signal: AbortSignal) => {
                            upstream = signal;
                            return delayedAudio(signal, 9_000);
                        },
                    })
                    .then(
                        (result) => result,
                        (error: unknown) => ({ error }),
                    );
                await jest.advanceTimersByTimeAsync(6_000);
                expect(upstream?.aborted).toBe(false);
                await jest.advanceTimersByTimeAsync(3_000);
                await expect(pending).resolves.toEqual({ stream: "playing" });
                expect(upstream?.aborted).toBe(false);
            },
        );

        it("keeps the primary winner pinned and cancels a pending late alternate", async () => {
            let alternateSignal: AbortSignal | undefined;
            const resolve = jest.fn(
                async (_user, _recording, signal: AbortSignal) => {
                    alternateSignal = signal;
                    return new Promise<{ streamPath: string }>((finish) => {
                        setTimeout(
                            () => finish({ streamPath: "/late" }),
                            3_000,
                        );
                    });
                },
            );
            const fallback = createMusicSourceFallback({
                enabled: async () => true,
                recording: async () => recording,
                resolve,
            });
            const first = input();
            let upstream: AbortSignal | undefined;
            const pending = fallback.acquire({
                ...first,
                original: (signal: AbortSignal) => {
                    upstream = signal;
                    return delayedAudio(signal, 7_000);
                },
            });
            await jest.advanceTimersByTimeAsync(6_000);
            expect(resolve).toHaveBeenCalledTimes(1);
            expect(upstream?.aborted).toBe(false);
            expect(alternateSignal?.aborted).toBe(false);
            await jest.advanceTimersByTimeAsync(1_000);
            await expect(pending).resolves.toEqual({ stream: "playing" });
            expect(alternateSignal?.aborted).toBe(true);
            await jest.advanceTimersByTimeAsync(2_000);
            const original = jest.fn(async () => "original seek");
            await expect(
                fallback.acquire({ ...first, range: "bytes=100-", original }),
            ).resolves.toEqual({ stream: "original seek" });
            expect(resolve).toHaveBeenCalledTimes(1);
            expect(upstream?.aborted).toBe(false);
        });

        it("cancels both pending sources without pinning a late alternate after owner cancellation", async () => {
            const controller = new AbortController();
            const reason = new Error("listener switched tracks");
            let alternateSignal: AbortSignal | undefined;
            const resolve = jest.fn(
                async (_user, _recording, signal: AbortSignal) => {
                    alternateSignal = signal;
                    return new Promise<{ streamPath: string }>((finish) => {
                        setTimeout(
                            () => finish({ streamPath: "/stale" }),
                            3_000,
                        );
                    });
                },
            );
            const fallback = createMusicSourceFallback({
                enabled: async () => true,
                recording: async () => recording,
                resolve,
            });
            const first = input();
            let upstream: AbortSignal | undefined;
            const pending = fallback.acquire({
                ...first,
                signal: controller.signal,
                original: (signal: AbortSignal) => {
                    upstream = signal;
                    return delayedAudio(signal, 9_000);
                },
            });
            const cancelled = expect(pending).rejects.toBe(reason);
            await jest.advanceTimersByTimeAsync(6_500);
            expect(resolve).toHaveBeenCalledTimes(1);
            controller.abort(reason);
            await cancelled;
            expect(upstream?.aborted).toBe(true);
            expect(alternateSignal?.aborted).toBe(true);
            await jest.advanceTimersByTimeAsync(2_500);
            await expect(
                fallback.acquire({ ...first, original: async () => "fresh" }),
            ).resolves.toEqual({ stream: "fresh" });
            expect(resolve).toHaveBeenCalledTimes(1);
        });

        it("reuses an already pending exact lookup after an eligible primary failure", async () => {
            const resolve = jest.fn(
                async () =>
                    new Promise<{ streamPath: string }>((finish) => {
                        setTimeout(
                            () => finish({ streamPath: "/alternate" }),
                            3_000,
                        );
                    }),
            );
            const fallback = createMusicSourceFallback({
                recording: async () => recording,
                resolve,
            });
            const pending = fallback.acquire({
                ...input(),
                original: () =>
                    new Promise<string>((_, reject) => {
                        setTimeout(() => reject(failure), 7_000);
                    }),
            });
            await jest.advanceTimersByTimeAsync(6_000);
            expect(resolve).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(3_000);
            await expect(pending).resolves.toEqual({ redirect: "/alternate" });
            expect(resolve).toHaveBeenCalledTimes(1);
        });

        it.each([403, 451])(
            "preserves HTTP %s when the primary rejects before a pending alternate is selected",
            async (status) => {
                let alternateSignal: AbortSignal | undefined;
                const resolve = jest.fn(
                    async (_user, _recording, signal: AbortSignal) => {
                        alternateSignal = signal;
                        return new Promise<{ streamPath: string }>((finish) => {
                            setTimeout(
                                () => finish({ streamPath: "/late" }),
                                3_000,
                            );
                        });
                    },
                );
                const fallback = createMusicSourceFallback({
                    recording: async () => recording,
                    resolve,
                });
                const error = { response: { status } };
                const first = input();
                const pending = fallback.acquire({
                    ...first,
                    original: () =>
                        new Promise<string>((_, reject) => {
                            setTimeout(() => reject(error), 7_000);
                        }),
                });
                const rejected = expect(pending).rejects.toBe(error);
                await jest.advanceTimersByTimeAsync(6_000);
                expect(resolve).toHaveBeenCalledTimes(1);
                await jest.advanceTimersByTimeAsync(1_000);
                await rejected;
                expect(alternateSignal?.aborted).toBe(true);
                await jest.advanceTimersByTimeAsync(2_000);
                await expect(
                    fallback.acquire({
                        ...first,
                        original: async () => "fresh",
                    }),
                ).resolves.toEqual({ stream: "fresh" });
            },
        );

        it("honors the internal fallback delay override without shortening the hard primary budget", async () => {
            const resolve = jest.fn(async () => null);
            const fallback = createMusicSourceFallback({
                fallbackDelayMs: 500,
                recording: async () => recording,
                resolve,
            });
            let upstream: AbortSignal | undefined;
            const pending = fallback.acquire({
                ...input(),
                original: (signal: AbortSignal) => {
                    upstream = signal;
                    return delayedAudio(signal, 9_000);
                },
            });
            await jest.advanceTimersByTimeAsync(499);
            expect(resolve).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(1);
            expect(resolve).toHaveBeenCalledTimes(1);
            expect(upstream?.aborted).toBe(false);
            await jest.advanceTimersByTimeAsync(8_500);
            await expect(pending).resolves.toEqual({ stream: "playing" });
        });
    });
});
