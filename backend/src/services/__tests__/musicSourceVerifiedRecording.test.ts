import { Readable } from "node:stream";
import { createMusicSourceResolver } from "../musicSources/resolver";
import type {
    MusicSourceAdapter,
    MusicSourceTrack,
} from "../musicSources/types";

function fixture(provider: "vk" | "yandex" = "vk") {
    const recording: MusicSourceTrack = {
        provider,
        id: provider === "vk" ? "-12_34" : "1234",
        title: "Exact recording",
        artists: ["Artist", "Guest"],
        duration: 180.125,
        contentVersion: "clean",
        preview: false,
        isrc: "USABC2600001",
    };
    const source: MusicSourceAdapter = {
        provider,
        version: 7,
        enabled: true,
        lookup: jest.fn(async () => recording),
        search: jest.fn(async () => [recording]),
        open: jest.fn(async () => ({
            status: 206,
            headers: { etag: '"exact"', "content-range": "bytes 0-0/100" },
            data: Readable.from([Buffer.from("a")]),
        })),
    };
    const recordVerified = jest.fn(
        async (_input: unknown, _signal: AbortSignal, _budgetMs: number) => {},
    );
    const options = {
        connections: async () => [source],
        recordVerified,
        now: () => 1_000_000,
    };
    return {
        recording,
        source,
        recordVerified,
        options,
        resolver: createMusicSourceResolver(options),
    };
}

test.each(["vk", "yandex"] as const)(
    "exact playable %s recording supplies server metadata without changing its lease",
    async (provider) => {
        const { recording, recordVerified, resolver } = fixture(provider);
        const lease = await resolver.resolve(
            "owner",
            null,
            new AbortController().signal,
            provider,
            recording.id,
        );
        expect(lease).toMatchObject({ provider });
        expect(recordVerified).toHaveBeenCalledTimes(1);
        expect(recordVerified.mock.calls[0][0]).toEqual({
            provider,
            providerTrackId: recording.id,
            connectionVersion: 7,
            recording,
            observedAt: new Date(1_000_000),
        });
        expect(recordVerified.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
        expect(recordVerified.mock.calls[0][2]).toBeGreaterThan(0);
        expect(recordVerified.mock.calls[0][2]).toBeLessThanOrEqual(500);
        expect(Object.keys(lease!).sort()).toEqual([
            "expiresAt",
            "leaseId",
            "provider",
            "streamPath",
        ]);
    },
);

test("text search alone does not become an exact recording attestation", async () => {
    const { recording, recordVerified, resolver } = fixture();
    expect(
        await resolver.resolve(
            "owner",
            recording,
            new AbortController().signal,
        ),
    ).toMatchObject({ provider: "vk" });
    expect(recordVerified).not.toHaveBeenCalled();
});

test.each(["replaced-id", "preview", "probe-failed"])(
    "%s cannot persist trusted metadata",
    async (failure) => {
        const { recording, source, recordVerified, resolver } = fixture();
        if (failure === "replaced-id")
            source.lookup = jest.fn(async () => ({
                ...recording,
                id: "-12_35",
            }));
        if (failure === "preview")
            source.lookup = jest.fn(async () => ({
                ...recording,
                preview: true,
            }));
        if (failure === "probe-failed")
            source.open = jest.fn(async () => {
                throw new Error("probe unavailable");
            });
        expect(
            await resolver.resolve(
                "owner",
                null,
                new AbortController().signal,
                "vk",
                recording.id,
            ),
        ).toBeNull();
        expect(recordVerified).not.toHaveBeenCalled();
    },
);

test("optional metadata database failure retains the already probed playable lease", async () => {
    const { recording, recordVerified, resolver } = fixture();
    recordVerified.mockRejectedValue(new Error("private-database-details"));
    const lease = await resolver.resolve(
        "owner",
        null,
        new AbortController().signal,
        "vk",
        recording.id,
    );
    expect(recordVerified).toHaveBeenCalledTimes(1);
    expect(lease).toMatchObject({ provider: "vk" });
    expect(JSON.stringify(lease)).not.toContain("private-database-details");
    expect(resolver.health().circuits).toEqual([]);
});

test.each([
    "writer-fulfilled",
    "writer-rejected",
    "probe-cleanup-no-writer",
    "probe-cleanup-low-budget",
])(
    "cancellation during %s resumption does not publish a lease",
    async (mode) => {
        const { recording, source, options } = fixture();
        const controller = new AbortController();
        let scheduled = false;
        let leasesAtAbort: number | undefined;
        let resolver: ReturnType<typeof createMusicSourceResolver>;
        const schedule = (depth: number) => {
            if (scheduled) return;
            scheduled = true;
            const tick = (remaining: number) =>
                queueMicrotask(() => {
                    if (remaining > 1) tick(remaining - 1);
                    else {
                        leasesAtAbort = resolver.health().leases;
                        controller.abort();
                    }
                });
            tick(depth);
        };
        const clock = jest.spyOn(performance, "now").mockReturnValue(0);
        const writer = jest.fn(() => {
            schedule(5);
            return mode === "writer-rejected"
                ? Promise.reject(new Error("optional failure"))
                : Promise.resolve();
        });
        if (mode.startsWith("probe")) {
            if (mode === "probe-cleanup-low-budget")
                source.lookup = async () => {
                    clock.mockReturnValue(15_910);
                    return recording;
                };
            source.open = async () => {
                const data = Readable.from([Buffer.from("a")]);
                const destroy = data.destroy.bind(data);
                data.destroy = (...args) => {
                    schedule(3);
                    return destroy(...args);
                };
                return {
                    status: 206,
                    headers: {
                        etag: '"exact"',
                        "content-range": "bytes 0-0/100",
                    },
                    data,
                };
            };
        }
        resolver = createMusicSourceResolver({
            ...options,
            recordVerified:
                mode === "probe-cleanup-no-writer" ? undefined : writer,
        });
        try {
            await expect(
                resolver.resolve(
                    "owner",
                    null,
                    controller.signal,
                    "vk",
                    recording.id,
                ),
            ).rejects.toMatchObject({ name: "AbortError" });
            expect(leasesAtAbort).toBe(0);
            expect(resolver.health().leases).toBe(0);
            if (mode.startsWith("probe")) expect(writer).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
        }
    },
);

describe("optional metadata budget", () => {
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    });
    afterEach(() => jest.useRealTimers());

    test("a non-cooperative writer cannot delay playback beyond its 500ms allowance", async () => {
        const { recording, recordVerified, resolver } = fixture();
        recordVerified.mockImplementation(() => new Promise<void>(() => {}));
        let lease: unknown;
        const work = resolver
            .resolve(
                "owner",
                null,
                new AbortController().signal,
                "vk",
                recording.id,
            )
            .then((result) => (lease = result));
        await jest.advanceTimersByTimeAsync(499);
        expect(recordVerified).toHaveBeenCalledTimes(1);
        expect(lease).toBeUndefined();
        await jest.advanceTimersByTimeAsync(1);
        await work;
        expect(lease).toMatchObject({ provider: "vk" });
        expect(recordVerified.mock.calls[0][1].aborted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });

    test("listener cancellation during metadata does not publish a lease", async () => {
        const { recording, recordVerified, resolver } = fixture();
        const controller = new AbortController();
        recordVerified.mockImplementation(() => new Promise<void>(() => {}));
        const work = resolver
            .resolve("owner", null, controller.signal, "vk", recording.id)
            .catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(1);
        expect(recordVerified).toHaveBeenCalledTimes(1);
        controller.abort();
        expect(await work).toMatchObject({ name: "AbortError" });
        expect(recordVerified.mock.calls[0][1].aborted).toBe(true);
        expect(resolver.health().leases).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test("a slow playable lookup retains its lease without optional metadata work", async () => {
        const { recording, source, recordVerified, resolver } = fixture();
        source.lookup = jest.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15_950));
            return recording;
        });
        const work = resolver.resolve(
            "owner",
            null,
            new AbortController().signal,
            "vk",
            recording.id,
        );
        await jest.advanceTimersByTimeAsync(15_950);
        expect(await work).toMatchObject({ provider: "vk" });
        expect(recordVerified).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });
});
