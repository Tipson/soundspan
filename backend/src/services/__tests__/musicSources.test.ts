import { Readable } from "node:stream";
import { createMusicSourceResolver } from "../musicSources/resolver";
import { matchesRecording } from "../musicSources/matcher";
import { createMusicSourceAdapter } from "../musicSources/adapters";
import {
    MusicSourceError,
    type MusicSourceAdapter,
    type MusicSourceTrack,
} from "../musicSources/types";

const track: MusicSourceTrack = {
    provider: "yandex",
    id: "123",
    title: "Пьяная",
    artists: ["Папин Олимпос"],
    duration: 159,
    contentVersion: "explicit",
    preview: false,
};
const signal = () => new AbortController().signal;
function adapter(provider: "yandex" | "vk" = "yandex"): MusicSourceAdapter {
    return {
        provider,
        version: 1,
        enabled: true,
        search: jest.fn(async () => [{ ...track, provider }]),
        lookup: jest.fn(async () => ({ ...track, provider })),
        open: jest.fn(async () => ({
            status: 206,
            headers: {
                "content-type": "audio/mpeg",
                "content-range": "bytes 0-2/3",
                "content-length": "3",
                etag: '"version-one"',
            },
            data: Readable.from([Buffer.from("abc")]),
        })),
    };
}
describe("server music sources", () => {
    it("matches the exact recording and tolerates normal punctuation", () => {
        expect(matchesRecording(track, { ...track, title: "Пьяная!" })).toBe(
            true,
        );
    });
    it.each([
        "live",
        "remix",
        "karaoke",
        "cover",
        "sped up",
        "slowed",
        "remaster",
    ])("rejects an unsolicited %s version", (version) => {
        expect(
            matchesRecording(track, { ...track, title: `Пьяная (${version})` }),
        ).toBe(false);
    });
    it("rejects clean, preview, wrong artist and different duration", () => {
        expect(
            matchesRecording(track, { ...track, contentVersion: "clean" }),
        ).toBe(false);
        expect(matchesRecording(track, { ...track, preview: true })).toBe(
            false,
        );
        expect(matchesRecording(track, { ...track, artists: ["Другой"] })).toBe(
            false,
        );
        expect(matchesRecording(track, { ...track, duration: 210 })).toBe(
            false,
        );
        expect(
            matchesRecording(track, { ...track, contentVersion: "unknown" }),
        ).toBe(false);
    });
    it("does not let an ISRC bypass version, duration or preview checks", () => {
        const withIsrc = { ...track, isrc: "RUA012600001" };
        expect(
            matchesRecording(withIsrc, {
                ...withIsrc,
                contentVersion: "unknown",
            }),
        ).toBe(true);
        expect(
            matchesRecording(withIsrc, {
                ...withIsrc,
                contentVersion: "clean",
            }),
        ).toBe(false);
        expect(matchesRecording(withIsrc, { ...withIsrc, preview: true })).toBe(
            false,
        );
    });
    it("shares the service connection but binds each lease to its Soundspan user", async () => {
        const source = adapter();
        const resolver = createMusicSourceResolver({
            connections: async () => [source],
        });
        const a = await resolver.resolve("a", track, signal());
        const b = await resolver.resolve("b", track, signal());
        expect(a!.leaseId).not.toBe(b!.leaseId);
        (source.open as jest.Mock).mockClear();
        await expect(
            resolver.open("b", a!.leaseId, {}, signal()),
        ).rejects.toMatchObject({ code: "not_found" });
        expect(source.open).not.toHaveBeenCalled();
        const stream = await resolver.open(
            "a",
            a!.leaseId,
            { range: "bytes=1-2" },
            signal(),
        );
        expect(source.open).toHaveBeenCalledWith(
            "123",
            { range: "bytes=1-2", ifRange: '"version-one"' },
            expect.any(AbortSignal),
        );
        stream.data.destroy();
        expect(JSON.stringify(a)).not.toMatch(/https:|token|credential/);
    });
    it("rejects ambiguous candidates instead of playing the first search result", async () => {
        const source = adapter();
        source.search = jest.fn(async () => [track, { ...track, id: "124" }]);
        const resolver = createMusicSourceResolver({
            connections: async () => [source],
        });
        expect(await resolver.resolve("a", track, signal())).toBeNull();
    });
    it("falls back after a challenge and prevents subsequent requests hammering that source", async () => {
        const failed = adapter();
        failed.search = jest.fn(async () => {
            throw new MusicSourceError("provider_challenge");
        });
        const backup = adapter("vk");
        const resolver = createMusicSourceResolver({
            connections: async () => [failed, backup],
        });
        expect((await resolver.resolve("a", track, signal()))!.provider).toBe(
            "vk",
        );
        expect((await resolver.resolve("b", track, signal()))!.provider).toBe(
            "vk",
        );
        expect(failed.search).toHaveBeenCalledTimes(1);
    });
    it("rejects expired and revoked credentials before opening the stream", async () => {
        let now = 0;
        const source = adapter();
        const resolver = createMusicSourceResolver({
            connections: async () => [source],
            now: () => now,
        });
        const a = await resolver.resolve("a", track, signal());
        source.version = 2;
        await expect(
            resolver.open("a", a!.leaseId, {}, signal()),
        ).rejects.toMatchObject({ code: "lease_expired" });
        const b = await resolver.resolve("a", track, signal());
        now = 3_600_001;
        (source.open as jest.Mock).mockClear();
        await expect(
            resolver.open("a", b!.leaseId, {}, signal()),
        ).rejects.toMatchObject({ code: "lease_expired" });
        expect(source.open).not.toHaveBeenCalled();
    });
    it("does not start provider work for an aborted request", async () => {
        const source = adapter();
        const resolver = createMusicSourceResolver({
            connections: async () => [source],
        });
        const c = new AbortController();
        c.abort();
        await expect(
            resolver.resolve("a", track, c.signal),
        ).rejects.toBeDefined();
        expect(source.search).not.toHaveBeenCalled();
    });
    it("caps active streams and releases a slot when the client disconnects", async () => {
        const source = adapter();
        const resolver = createMusicSourceResolver({
            connections: async () => [source],
            maxStreams: 1,
        });
        const a = await resolver.resolve("a", track, signal());
        const opened = await resolver.open("a", a!.leaseId, {}, signal());
        await expect(
            resolver.open("a", a!.leaseId, {}, signal()),
        ).rejects.toMatchObject({ code: "busy" });
        opened.data.destroy();
        await new Promise(setImmediate);
        const next = await resolver.open("a", a!.leaseId, {}, signal());
        next.data.destroy();
    });
    it("falls back when search succeeds but audio is unavailable", async () => {
        const first = adapter();
        first.open = jest.fn(async () => {
            throw new MusicSourceError("entitlement_required");
        });
        const resolver = createMusicSourceResolver({
            connections: async () => [first, adapter("vk")],
        });
        expect((await resolver.resolve("a", track, signal()))!.provider).toBe(
            "vk",
        );
    });
    it("keeps another user's full recording playable after a preview-only recording", async () => {
        const json = jest.fn(async (url: string) => {
            if (url.includes("/search?")) {
                const restricted = new URL(url).searchParams
                    .get("text")!
                    .includes("Restricted");
                return {
                    result: {
                        tracks: {
                            results: [
                                {
                                    id: restricted ? "1" : "2",
                                    title: restricted
                                        ? "Restricted"
                                        : "Available",
                                    artists: [{ name: "Artist" }],
                                    durationMs: 180000,
                                    available: true,
                                },
                            ],
                        },
                    },
                };
            }
            return {
                result: [
                    {
                        codec: "mp3",
                        bitrateInKbps: 192,
                        preview: url.includes("/tracks/1/"),
                        downloadInfoUrl: "https://storage.mds.yandex.net/info",
                    },
                ],
            };
        });
        const source = createMusicSourceAdapter("yandex", "fixture-secret", 1, {
            json,
            text: async () =>
                "<download-info><host>storage.mds.yandex.net</host><path>/abc</path><ts>123</ts><s>xyz</s></download-info>",
            stream: async () => ({
                status: 206,
                headers: {
                    "content-type": "audio/mpeg",
                    "content-range": "bytes 0-0/100",
                    etag: '"fixture"',
                },
                data: Readable.from([Buffer.from("a")]),
            }),
        });
        const resolver = createMusicSourceResolver({
            connections: async () => [source],
        });
        const wanted = {
            artists: ["Artist"],
            duration: 180,
            contentVersion: "unknown" as const,
        };
        expect(
            await resolver.resolve(
                "a",
                { ...wanted, title: "Restricted" },
                signal(),
            ),
        ).toBeNull();
        const result = await resolver.resolve(
            "b",
            { ...wanted, title: "Available" },
            signal(),
        );
        expect(result?.provider).toBe("yandex");
        expect(resolver.health().circuits).toEqual([]);
        expect(
            json.mock.calls.filter(([url]) => url.includes("/search?")),
        ).toHaveLength(2);
    });
    it.each([
        "auth_required",
        "entitlement_required",
        "rate_limit",
        "provider_challenge",
    ] as const)(
        "retains the connection circuit for a real %s failure",
        async (code) => {
            const source = adapter();
            source.search = jest.fn(async () => {
                throw new MusicSourceError(code);
            });
            const resolver = createMusicSourceResolver({
                connections: async () => [source],
            });
            expect(await resolver.resolve("a", track, signal())).toBeNull();
            expect(await resolver.resolve("b", track, signal())).toBeNull();
            expect(source.search).toHaveBeenCalledTimes(1);
            expect(resolver.health().circuits[0]).toMatchObject({
                connection: "yandex:1",
                code,
            });
        },
    );
    it("rejects a changed representation on seek instead of mixing bytes", async () => {
        const source = adapter();
        const resolver = createMusicSourceResolver({
            connections: async () => [source],
        });
        const lease = await resolver.resolve("a", track, signal());
        source.open = jest.fn(async () => ({
            status: 206,
            headers: {
                "content-type": "audio/mpeg",
                "content-range": "bytes 1-2/3",
                etag: '"changed"',
            },
            data: Readable.from(["xx"]),
        }));
        await expect(
            resolver.open(
                "a",
                lease!.leaseId,
                { range: "bytes=1-2" },
                signal(),
            ),
        ).rejects.toMatchObject({ code: "lease_expired" });
    });
    it("rejects explicit markers mislabeled as unknown", () => {
        const original = { ...track, isrc: "RUA012600001" };
        expect(
            matchesRecording(original, {
                ...original,
                title: "Пьяная (clean)",
                contentVersion: "unknown",
            }),
        ).toBe(false);
        expect(
            matchesRecording(original, {
                ...original,
                title: "Пьяная (цензура)",
                contentVersion: "unknown",
            }),
        ).toBe(false);
    });
    it("lets diagnostics constrain the provider instead of testing another source", async () => {
        const first = adapter();
        const resolver = createMusicSourceResolver({
            connections: async () => [first, adapter("vk")],
        });
        expect(
            (await resolver.resolve("a", track, signal(), "vk"))!.provider,
        ).toBe("vk");
        expect(first.search).not.toHaveBeenCalled();
    });
    it("immediately cancels active and in-flight streams when an administrator revokes a source", async () => {
        const source = adapter();
        const resolver = createMusicSourceResolver({
            connections: async () => [source],
        });
        const lease = await resolver.resolve("a", track, signal());
        const current = await resolver.open("a", lease!.leaseId, {}, signal());
        resolver.revokeProvider("yandex");
        expect(current.data.destroyed).toBe(true);
        await expect(
            resolver.open("a", lease!.leaseId, {}, signal()),
        ).rejects.toMatchObject({ code: "not_found" });
        await new Promise(setImmediate);
        expect(resolver.health().activeStreams).toEqual({});
    });
});
