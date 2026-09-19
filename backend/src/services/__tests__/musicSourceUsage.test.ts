import { Readable } from "node:stream";
import { createMusicSourceResolver } from "../musicSources/resolver";
import {
    MusicSourceError,
    type MusicSourceAdapter,
} from "../musicSources/types";

const track = {
    provider: "yandex" as const,
    id: "private-track",
    title: "Fixture",
    artists: ["Fixture"],
    duration: 180,
    contentVersion: "unknown" as const,
    preview: false,
};
function source(): MusicSourceAdapter {
    return {
        provider: "yandex",
        version: 1,
        enabled: true,
        search: jest.fn(async () => [track]),
        lookup: jest.fn(async () => track),
        open: jest.fn(async () => ({
            status: 206,
            headers: {
                etag: '"one"',
                "content-range": "bytes 0-2/3",
                "content-length": "3",
            },
            data: Readable.from([Buffer.from("abc")]),
        })),
    };
}
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("bounded music source usage diagnostics", () => {
    it("counts actual resolution and completed HTTP streams without listener or recording identity", async () => {
        const adapter = source();
        const resolver = createMusicSourceResolver({
            connections: async () => [adapter],
            now: () => 100,
        });
        const lease = await resolver.resolve(
            "private-listener",
            track,
            signal(),
        );
        const stream = await resolver.open(
            "private-listener",
            lease!.leaseId,
            {},
            signal(),
        );
        for await (const _chunk of stream.data) {
            /* consume the real stream lifecycle */
        }
        await tick();
        expect(resolver.health()).toMatchObject({
            usage: {
                since: 100,
                providers: {
                    yandex: {
                        resolutionAttempts: 1,
                        selected: 1,
                        noMatch: 0,
                        resolutionFailed: 0,
                        streamRequests: 1,
                        streamCompleted: 1,
                        streamFailed: 0,
                        streamCancelled: 0,
                    },
                },
            },
        });
        expect(JSON.stringify(resolver.health())).not.toMatch(
            /private-listener|private-track|https:|token/,
        );
    });
    it("classifies requester cancellation separately from source failure", async () => {
        const adapter = source();
        const controller = new AbortController();
        adapter.search = async (_query, abort) => {
            controller.abort();
            abort.throwIfAborted();
            return [];
        };
        const resolver = createMusicSourceResolver({
            connections: async () => [adapter],
        });
        await expect(
            resolver.resolve("a", track, controller.signal),
        ).rejects.toBeDefined();
        expect(resolver.health()).toMatchObject({
            circuits: [],
            usage: {
                providers: {
                    yandex: {
                        resolutionAttempts: 1,
                        resolutionCancelled: 1,
                        resolutionFailed: 0,
                    },
                },
            },
        });
    });
    it("reports source failures and expires cooldowns when an administrator refreshes health", async () => {
        let now = 0;
        const adapter = source();
        adapter.search = async () => {
            throw new MusicSourceError("rate_limit", 30);
        };
        const resolver = createMusicSourceResolver({
            connections: async () => [adapter],
            now: () => now,
        });
        await resolver.resolve("a", track, signal());
        now = 31_000;
        expect(resolver.health()).toMatchObject({
            circuits: [],
            usage: {
                providers: {
                    yandex: { resolutionFailed: 1, lastFailure: "rate_limit" },
                },
            },
        });
    });
    it("counts one cancelled body without treating it as a completed listening session", async () => {
        const adapter = source();
        const resolver = createMusicSourceResolver({
            connections: async () => [adapter],
        });
        const lease = await resolver.resolve("a", track, signal());
        const body = new Readable({ read() {} });
        adapter.open = async () => ({
            status: 206,
            headers: { etag: '"one"', "content-range": "bytes 0-2/3" },
            data: body,
        });
        const controller = new AbortController();
        await resolver.open("a", lease!.leaseId, {}, controller.signal);
        controller.abort();
        await tick();
        body.emit("close");
        expect(resolver.health()).toMatchObject({
            activeStreams: {},
            usage: {
                providers: {
                    yandex: {
                        streamRequests: 1,
                        streamCancelled: 1,
                        streamCompleted: 0,
                        streamFailed: 0,
                    },
                },
            },
        });
    });
    it("distinguishes a prematurely closed upstream from requester cancellation", async () => {
        const adapter = source();
        const resolver = createMusicSourceResolver({
            connections: async () => [adapter],
        });
        const lease = await resolver.resolve("a", track, signal());
        const body = new Readable({ read() {} });
        adapter.open = async () => ({
            status: 206,
            headers: { etag: '"one"', "content-range": "bytes 0-2/3" },
            data: body,
        });
        await resolver.open("a", lease!.leaseId, {}, signal());
        body.destroy();
        await tick();
        expect(resolver.health()).toMatchObject({
            usage: {
                providers: {
                    yandex: {
                        streamFailed: 1,
                        streamCancelled: 0,
                        streamCompleted: 0,
                    },
                },
            },
        });
    });
    it("does not label a source failure as cancellation when another provider is revoked", async () => {
        const adapter = source();
        let rejectSearch!: (error: unknown) => void;
        adapter.search = () =>
            new Promise((_resolve, reject) => {
                rejectSearch = reject;
            });
        const resolver = createMusicSourceResolver({
            connections: async () => [adapter],
        });
        const pending = resolver.resolve("a", track, signal());
        await tick();
        resolver.revokeProvider("vk");
        rejectSearch(new MusicSourceError("rate_limit"));
        expect(await pending).toBeNull();
        expect(resolver.health()).toMatchObject({
            circuits: [{ connection: "yandex:1", code: "rate_limit" }],
            usage: {
                providers: {
                    yandex: {
                        resolutionAttempts: 1,
                        resolutionFailed: 1,
                        resolutionCancelled: 0,
                        lastFailure: "rate_limit",
                    },
                },
            },
        });
    });
    it("counts revocation of the pending source as cancellation without arming a failure circuit", async () => {
        const adapter = source();
        adapter.search = (_query, abort) =>
            new Promise((_resolve, reject) => {
                abort.addEventListener("abort", () => reject(abort.reason), {
                    once: true,
                });
            });
        const resolver = createMusicSourceResolver({
            connections: async () => [adapter],
        });
        const pending = resolver.resolve("a", track, signal());
        await tick();
        resolver.revokeProvider("yandex");
        expect(await pending).toBeNull();
        expect(resolver.health()).toMatchObject({
            circuits: [],
            usage: {
                providers: {
                    yandex: {
                        resolutionAttempts: 1,
                        resolutionFailed: 0,
                        resolutionCancelled: 1,
                        lastFailure: null,
                    },
                },
            },
        });
    });
    it("preserves a classified body failure once across error and close", async () => {
        const adapter = source();
        const resolver = createMusicSourceResolver({
            connections: async () => [adapter],
        });
        const lease = await resolver.resolve("a", track, signal());
        const body = new Readable({ read() {} });
        adapter.open = async () => ({
            status: 206,
            headers: { etag: '\"one\"', "content-range": "bytes 0-2/3" },
            data: body,
        });
        await resolver.open("a", lease!.leaseId, {}, signal());
        body.destroy(new MusicSourceError("unsupported_stream"));
        await tick();
        expect(resolver.health()).toMatchObject({
            activeStreams: {},
            usage: {
                providers: {
                    yandex: {
                        streamRequests: 1,
                        streamCompleted: 0,
                        streamCancelled: 0,
                        streamFailed: 1,
                        lastFailure: "unsupported_stream",
                    },
                },
            },
        });
    });
});
