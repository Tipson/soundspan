import { createMusicSourceAdapter } from "../musicSources/adapters";
import { createMusicSourceCatalog } from "../musicSources/catalog";
import {
    MusicSourceError,
    type MusicSourceAdapter,
    type MusicSourceTrack,
} from "../musicSources/types";

const recording = (provider: "vk" | "yandex", index = 1): MusicSourceTrack => ({
    provider,
    id: provider === "vk" ? `-1_${index}` : String(index),
    title: `Song ${index}`,
    artists: [`Artist ${index}`],
    duration: 180,
    contentVersion: "unknown",
    preview: false,
});
const nativeAdapter = (provider: "vk" | "yandex"): MusicSourceAdapter => ({
    provider,
    version: 7,
    enabled: true,
    search: jest.fn(async () => [recording(provider)]),
    lookup: jest.fn(),
    open: jest.fn(),
    recommendations: jest.fn(async () =>
        Array.from({ length: 100 }, (_, i) => recording(provider, i + 1)),
    ),
});
describe("bounded native provider radio operation", () => {
    const signal = () => new AbortController().signal;
    it("rejects non-string seed identities instead of coercing them", async () => {
        const http = { json: jest.fn(), text: jest.fn(), stream: jest.fn() },
            source = createMusicSourceAdapter("yandex", "secret", 7, http),
            connections = jest.fn(async () => [source]),
            catalog = createMusicSourceCatalog({ connections });
        for (const value of [7, 7n, { toString: () => "7" }]) {
            await expect(
                source.recommendations!(
                    value as unknown as string,
                    1,
                    signal(),
                ),
            ).rejects.toMatchObject({ code: "invalid_request" });
            await expect(
                catalog.recommendations(
                    "yandex",
                    value as unknown as string,
                    1,
                    signal(),
                ),
            ).rejects.toMatchObject({ code: "invalid_request" });
        }
        expect(http.json).not.toHaveBeenCalled();
        expect(connections).not.toHaveBeenCalled();
    });
    it.each(["vk", "yandex"] as const)(
        "rejects rounded numeric %s identities and unavailable rows",
        async (provider) => {
            const http = {
                json: jest.fn(),
                text: jest.fn(),
                stream: jest.fn(),
            };
            const rows =
                provider === "vk"
                    ? [
                          {
                              id: Number.MAX_SAFE_INTEGER + 1,
                              owner_id: -1,
                              title: "Wrong",
                              artist: "A",
                              duration: 180,
                          },
                          {
                              id: 2,
                              owner_id: Number.MAX_SAFE_INTEGER + 1,
                              title: "Wrong",
                              artist: "A",
                              duration: 180,
                          },
                          {
                              id: 3,
                              owner_id: -1,
                              title: "Restricted",
                              artist: "A",
                              duration: 180,
                              is_restricted: true,
                          },
                          {
                              id: 4,
                              owner_id: -1,
                              title: "Good",
                              artist: "A",
                              duration: 180,
                          },
                      ]
                    : [
                          {
                              id: Number.MAX_SAFE_INTEGER + 1,
                              title: "Wrong",
                              artists: [{ name: "A" }],
                              durationMs: 180000,
                          },
                          {
                              id: "2",
                              title: "Unavailable",
                              artists: [{ name: "A" }],
                              durationMs: 180000,
                              available: false,
                          },
                          {
                              id: "0004",
                              title: "Good",
                              artists: [{ name: "A" }],
                              durationMs: 180000,
                          },
                      ];
            http.json.mockResolvedValue(
                provider === "vk"
                    ? { response: { items: rows } }
                    : { result: { similarTracks: rows } },
            );
            const source = createMusicSourceAdapter(
                provider,
                "secret",
                7,
                http,
            );
            expect(
                (
                    await source.recommendations!(
                        provider === "vk" ? "-1_1" : "1",
                        100,
                        signal(),
                    )
                ).map((t) => t.id),
            ).toEqual([provider === "vk" ? "-1_4" : "0004"]);
        },
    );
    it.each(["vk", "yandex"] as const)(
        "rejects malformed and oversized %s envelopes without a search fallback",
        async (provider) => {
            const http = {
                json: jest.fn(),
                text: jest.fn(),
                stream: jest.fn(),
            };
            const source = createMusicSourceAdapter(
                provider,
                "secret",
                7,
                http,
            );
            for (const payload of [
                null,
                {},
                { result: {} },
                provider === "vk"
                    ? { response: { items: Array(101).fill({}) } }
                    : { result: { similarTracks: Array(101).fill({}) } },
            ]) {
                http.json.mockResolvedValue(payload);
                await expect(
                    source.recommendations!(
                        provider === "vk" ? "-1_1" : "1",
                        100,
                        signal(),
                    ),
                ).rejects.toMatchObject({ code: "unavailable" });
            }
            expect(http.json).toHaveBeenCalledTimes(4);
            expect(http.text).not.toHaveBeenCalled();
            expect(http.stream).not.toHaveBeenCalled();
        },
    );
    it("validates catalog inputs before loading connections", async () => {
        const connections = jest.fn(async () => []),
            catalog = createMusicSourceCatalog({ connections });
        for (const [provider, id, count] of [
            ["vk", "x", 100],
            ["yandex", "7", 0],
            ["yandex", "7", NaN],
            ["yandex", "7", 1.5],
            ["other", "7", 100],
        ] as const)
            await expect(
                catalog.recommendations(provider as "vk", id, count, signal()),
            ).rejects.toMatchObject({ code: "invalid_request" });
        expect(connections).not.toHaveBeenCalled();
    });
    it("distinguishes disabled and missing sources from an exhausted finite pool", async () => {
        const vk = nativeAdapter("vk");
        let current: MusicSourceAdapter[] = [];
        const catalog = createMusicSourceCatalog({
            connections: async () => current,
        });
        expect(
            await catalog.recommendations("vk", "-1_1", 100, signal()),
        ).toEqual({ tracks: [], unavailable: ["vk"] });
        current = [{ ...vk, enabled: false }];
        expect(
            await catalog.recommendations("vk", "-1_1", 100, signal()),
        ).toEqual({ tracks: [], unavailable: ["vk"] });
        current = [{ ...vk, recommendations: jest.fn(async () => []) }];
        expect(
            await catalog.recommendations("vk", "-1_1", 100, signal()),
        ).toEqual({ tracks: [], unavailable: [] });
        expect(vk.search).not.toHaveBeenCalled();
    });
    it("sanitizes, bounds and deduplicates metadata before delivery or cache", async () => {
        const vk = nativeAdapter("vk"),
            good = recording("vk");
        vk.recommendations = jest.fn(
            async () =>
                [
                    {
                        ...good,
                        url: "secret",
                        token: "secret",
                        canonicalRecordingId: "forged",
                    },
                    good,
                    { ...good, id: "bad" },
                    { ...good, id: "-1_2", preview: true },
                    { ...good, id: "-1_3", provider: "yandex" },
                    { ...good, id: "-1_4", artists: [] },
                    { ...good, id: "-1_5", duration: Infinity },
                    ...Array.from({ length: 120 }, (_, i) =>
                        recording("vk", i + 10),
                    ),
                ] as MusicSourceTrack[],
        );
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
        });
        const result = await catalog.recommendations(
            "vk",
            "-1_1",
            100,
            signal(),
        );
        expect(result.tracks).toHaveLength(94);
        expect(result.tracks[0]).toEqual(good);
        expect(JSON.stringify(result)).not.toMatch(
            /secret|canonicalRecordingId|url|token/,
        );
        expect(result.tracks.at(-1)?.id).toBe("-1_102");
    });
    it("keeps exact source, seed and count namespaces distinct from normalized search", async () => {
        const vk = nativeAdapter("vk"),
            ym = nativeAdapter("yandex");
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk, ym],
        });
        for (const id of ["0007", "7"])
            await catalog.recommendations("yandex", id, 100, signal());
        await catalog.recommendations("yandex", "7", 1, signal());
        await catalog.recommendations("vk", "-1_7", 100, signal());
        await catalog.search("7", signal());
        await catalog.search(" 7 ", signal());
        expect(ym.recommendations).toHaveBeenCalledTimes(3);
        expect(vk.recommendations).toHaveBeenCalledTimes(1);
        expect(ym.search).toHaveBeenCalledTimes(1);
        expect(vk.search).toHaveBeenCalledTimes(1);
    });
    it("protects cached metadata from caller mutations and expires it after one minute", async () => {
        const vk = nativeAdapter("vk");
        let now = 1000;
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
            now: () => now,
        });
        const first = await catalog.recommendations("vk", "-1_1", 1, signal());
        first.tracks[0].title = "poison";
        first.tracks[0].artists[0] = "poison";
        first.tracks.push(recording("vk", 999));
        const cached = await catalog.recommendations("vk", "-1_1", 1, signal());
        expect(cached.tracks).toEqual([recording("vk")]);
        expect(vk.recommendations).toHaveBeenCalledTimes(1);
        now += 60_000;
        await catalog.recommendations("vk", "-1_1", 1, signal());
        expect(vk.recommendations).toHaveBeenCalledTimes(2);
    });
    it("rechecks generation even for cache hits and cannot republish an obsolete response", async () => {
        const vk = nativeAdapter("vk");
        let current: MusicSourceAdapter[] = [vk];
        let reads = 0;
        const catalog = createMusicSourceCatalog({
            connections: async () => {
                reads++;
                return reads === 4 ? [] : current;
            },
        });
        await catalog.recommendations("vk", "-1_1", 1, signal());
        expect(
            await catalog.recommendations("vk", "-1_1", 1, signal()),
        ).toEqual({ tracks: [], unavailable: ["vk"] });
        current = [
            {
                ...vk,
                version: 8,
                recommendations: jest.fn(async () => [recording("vk", 2)]),
            },
        ];
        expect(
            (await catalog.recommendations("vk", "-1_1", 1, signal())).tracks,
        ).toEqual([recording("vk", 2)]);
    });
    it("cancels before connection lookup and after it before starting a provider", async () => {
        const vk = nativeAdapter("vk"),
            controller = new AbortController();
        controller.abort(new Error("cancelled"));
        const connections = jest.fn(async () => [vk]),
            catalog = createMusicSourceCatalog({ connections });
        await expect(
            catalog.recommendations("vk", "-1_1", 1, controller.signal),
        ).rejects.toThrow("cancelled");
        expect(connections).not.toHaveBeenCalled();
        const later = new AbortController(),
            second = createMusicSourceCatalog({
                connections: async () => {
                    later.abort(new Error("later"));
                    return [vk];
                },
            });
        await expect(
            second.recommendations("vk", "-1_1", 1, later.signal),
        ).rejects.toThrow("later");
        expect(vk.recommendations).not.toHaveBeenCalled();
    });
    it("does not cache or deliver work completed after cancellation", async () => {
        const vk = nativeAdapter("vk"),
            controller = new AbortController();
        let finish!: (rows: MusicSourceTrack[]) => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        vk.recommendations = jest.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                    started();
                }),
        );
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
            concurrency: 1,
        });
        const pending = catalog.recommendations(
            "vk",
            "-1_1",
            1,
            controller.signal,
        );
        await ready;
        controller.abort(new Error("cancelled"));
        await expect(pending).rejects.toThrow("cancelled");
        expect(
            await catalog.recommendations("vk", "-1_1", 1, signal()),
        ).toEqual({ tracks: [], unavailable: ["vk"] });
        finish([recording("vk", 999)]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        vk.recommendations = jest.fn(async () => [recording("vk", 2)]);
        expect(
            (await catalog.recommendations("vk", "-1_1", 1, signal())).tracks,
        ).toEqual([recording("vk", 2)]);
    });
    it("cancellation during the final generation fence cannot publish or cache a result", async () => {
        const vk = nativeAdapter("vk"),
            controller = new AbortController();
        let reads = 0;
        const catalog = createMusicSourceCatalog({
            connections: async () => {
                if (++reads === 2) controller.abort(new Error("fence"));
                return [vk];
            },
        });
        await expect(
            catalog.recommendations("vk", "-1_1", 1, controller.signal),
        ).rejects.toThrow("fence");
        await catalog.recommendations("vk", "-1_1", 1, signal());
        expect(vk.recommendations).toHaveBeenCalledTimes(2);
    });
    it("releases a noncooperative timed out slot only when the underlying call settles", async () => {
        const vk = nativeAdapter("vk");
        let finish!: (rows: MusicSourceTrack[]) => void;
        vk.recommendations = jest.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
            timeoutMs: 15,
            concurrency: 1,
        });
        await catalog.recommendations("vk", "-1_1", 1, signal());
        expect((await catalog.search("Blocked", signal())).unavailable).toEqual(
            ["vk"],
        );
        finish([recording("vk")]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect((await catalog.search("Released", signal())).tracks).toEqual([
            recording("vk"),
        ]);
        expect(vk.search).toHaveBeenCalledTimes(1);
    });
    it.each([
        "auth_required",
        "rate_limit",
        "provider_challenge",
        "entitlement_required",
    ] as const)(
        "shares %s backoff across endpoints but resets it for a new generation",
        async (code) => {
            const vk = nativeAdapter("vk");
            let now = 0,
                current = vk;
            vk.search = jest.fn(async () => {
                throw new MusicSourceError(code, 1);
            });
            const catalog = createMusicSourceCatalog({
                connections: async () => [current],
                now: () => now,
            });
            await catalog.search("Challenged", signal());
            await catalog.recommendations("vk", "-1_1", 1, signal());
            expect(vk.recommendations).not.toHaveBeenCalled();
            now = 29_999;
            await catalog.recommendations("vk", "-1_1", 1, signal());
            expect(vk.recommendations).not.toHaveBeenCalled();
            current = { ...vk, version: 8 };
            await catalog.recommendations("vk", "-1_1", 1, signal());
            expect(vk.recommendations).toHaveBeenCalledTimes(1);
        },
    );
    it.each(["vk", "yandex"] as const)(
        "uses the exact %s similar endpoint without forwarding secrets in URLs",
        async (provider) => {
            const http = {
                json: jest.fn(),
                text: jest.fn(),
                stream: jest.fn(),
            };
            http.json.mockResolvedValue(
                provider === "vk"
                    ? {
                          response: {
                              items: [
                                  {
                                      id: 2,
                                      owner_id: -1,
                                      title: "Next",
                                      artist: "Artist",
                                      duration: 180,
                                      url: "https://private.invalid",
                                  },
                              ],
                          },
                      }
                    : {
                          result: {
                              similarTracks: [
                                  {
                                      id: "0002",
                                      title: "Next",
                                      artists: [{ name: "Artist" }],
                                      durationMs: 180000,
                                      available: true,
                                  },
                              ],
                          },
                      },
            );
            const source = createMusicSourceAdapter(
                    provider,
                    "private-token",
                    7,
                    http,
                ),
                signal = new AbortController().signal,
                seed = provider === "vk" ? "-001_002" : "0007";
            const tracks = await source.recommendations!(seed, 100, signal);
            expect(tracks).toEqual([
                expect.objectContaining({
                    provider,
                    id: provider === "vk" ? "-1_2" : "0002",
                    title: "Next",
                    preview: false,
                }),
            ]);
            expect(http.json.mock.calls[0][0]).toBe(
                provider === "vk"
                    ? "https://api.vk.com/method/audio.getRecommendations?target_audio=-001_002&count=100&v=5.199"
                    : "https://api.music.yandex.net/tracks/0007/similar",
            );
            expect(http.json.mock.calls[0][0]).not.toContain("private-token");
            expect(JSON.stringify(tracks)).not.toMatch(/private|url|token/);
            expect(http.stream).not.toHaveBeenCalled();
            expect(http.text).not.toHaveBeenCalled();
        },
    );
    it.each(["vk", "yandex"] as const)(
        "validates %s exact seed and count before HTTP",
        async (provider) => {
            const http = {
                    json: jest.fn(),
                    text: jest.fn(),
                    stream: jest.fn(),
                },
                source = createMusicSourceAdapter(provider, "secret", 7, http);
            for (const [seed, count] of [
                ["wrong", 100],
                [provider === "vk" ? "-1_2" : "7", NaN],
                [provider === "vk" ? "-1_2" : "7", 101],
                [provider === "vk" ? "-1_2" : "7", 0],
            ] as const)
                await expect(
                    source.recommendations!(
                        seed,
                        count,
                        new AbortController().signal,
                    ),
                ).rejects.toMatchObject({ code: "invalid_request" });
            expect(http.json).not.toHaveBeenCalled();
        },
    );
    it("retains up to100raw valid songs for listener admission instead of search's20", async () => {
        const vk = nativeAdapter("vk"),
            catalog = createMusicSourceCatalog({
                connections: async () => [vk],
            });
        const result = await catalog.recommendations(
            "vk",
            "-001_002",
            100,
            new AbortController().signal,
        );
        expect(result.tracks).toHaveLength(100);
        expect(result.unavailable).toEqual([]);
        expect(vk.recommendations).toHaveBeenCalledWith(
            "-001_002",
            100,
            expect.any(AbortSignal),
        );
        const search = await catalog.search(
            "Other",
            new AbortController().signal,
        );
        expect(search.tracks).toHaveLength(1);
        expect(
            await catalog.recommendations(
                "vk",
                "-001_002",
                100,
                new AbortController().signal,
            ),
        ).toEqual(result);
        expect(vk.recommendations).toHaveBeenCalledTimes(1);
    });
    it("fences disabled or changed credentials before cached delivery", async () => {
        const vk = nativeAdapter("vk");
        let current = [vk];
        vk.recommendations = jest.fn(async () => {
            current = [];
            return [recording("vk")];
        });
        const catalog = createMusicSourceCatalog({
            connections: async () => current,
        });
        expect(
            await catalog.recommendations(
                "vk",
                "-1_2",
                100,
                new AbortController().signal,
            ),
        ).toEqual({ tracks: [], unavailable: ["vk"] });
        current = [
            {
                ...vk,
                version: 8,
                recommendations: jest.fn(async () => [recording("vk", 2)]),
            },
        ];
        expect(
            (
                await catalog.recommendations(
                    "vk",
                    "-1_2",
                    100,
                    new AbortController().signal,
                )
            ).tracks[0].id,
        ).toBe("-1_2");
    });
    it("shares source slots with search and retains timed-out noncooperative work's slot", async () => {
        const vk = nativeAdapter("vk");
        let finish!: (r: MusicSourceTrack[]) => void;
        vk.recommendations = jest.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
            concurrency: 1,
            timeoutMs: 15,
        });
        expect(
            await catalog.recommendations(
                "vk",
                "-1_2",
                100,
                new AbortController().signal,
            ),
        ).toEqual({ tracks: [], unavailable: ["vk"] });
        expect(
            await catalog.search("Other", new AbortController().signal),
        ).toEqual({ tracks: [], unavailable: ["vk"] });
        expect(vk.search).not.toHaveBeenCalled();
        finish([recording("vk")]);
    });
    it("marks an absent optional endpoint unavailable without library or search fallback", async () => {
        const vk = nativeAdapter("vk");
        delete vk.recommendations;
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
        });
        expect(
            await catalog.recommendations(
                "vk",
                "-1_2",
                100,
                new AbortController().signal,
            ),
        ).toEqual({ tracks: [], unavailable: ["vk"] });
        expect(vk.search).not.toHaveBeenCalled();
    });
    it("backs off a challenged provider across recommendations and search", async () => {
        const vk = nativeAdapter("vk");
        vk.recommendations = jest.fn(async () => {
            throw new MusicSourceError("provider_challenge");
        });
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
        });
        expect(
            (
                await catalog.recommendations(
                    "vk",
                    "-1_2",
                    100,
                    new AbortController().signal,
                )
            ).unavailable,
        ).toEqual(["vk"]);
        await catalog.search("Other", new AbortController().signal);
        expect(vk.search).not.toHaveBeenCalled();
    });
});
