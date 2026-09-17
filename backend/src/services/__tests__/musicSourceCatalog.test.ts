import { createMusicSourceCatalog } from "../musicSources/catalog";
import {
    MusicSourceError,
    type MusicSourceAdapter,
    type MusicSourceTrack,
} from "../musicSources/types";

const track: MusicSourceTrack = {
    provider: "vk",
    id: "1_2",
    title: "Song",
    artists: ["Artist"],
    duration: 180,
    contentVersion: "explicit",
    preview: false,
};
function adapter(provider: "vk" | "yandex"): MusicSourceAdapter {
    return {
        provider,
        version: 1,
        enabled: true,
        search: jest.fn(async () => [
            { ...track, provider, id: provider === "vk" ? "1_2" : "3" },
        ]),
        lookup: jest.fn(),
        open: jest.fn(),
    };
}
describe("service catalog search", () => {
    it("returns a healthy catalog by the deadline even if another ignores cancellation", async () => {
        const vk = adapter("vk"),
            yandex = adapter("yandex");
        let finish!: (rows: MusicSourceTrack[]) => void;
        vk.search = jest.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk, yandex],
            concurrency: 1,
            timeoutMs: 15,
        });
        const result = await catalog.search(
            "Song",
            new AbortController().signal,
        );
        expect(result.tracks).toEqual([
            expect.objectContaining({ provider: "yandex" }),
        ]);
        expect(result.unavailable).toEqual(["vk"]);
        await catalog.search("Other", new AbortController().signal);
        expect(vk.search).toHaveBeenCalledTimes(1);
        finish([track]);
    });
    it("discards results from a connection disabled while the query was running", async () => {
        const vk = adapter("vk");
        let current: MusicSourceAdapter[] = [vk];
        vk.search = jest.fn(async () => {
            current = [];
            return [track];
        });
        const catalog = createMusicSourceCatalog({
            connections: async () => current,
        });
        expect(
            await catalog.search("Song", new AbortController().signal),
        ).toEqual({ tracks: [], unavailable: [] });
    });
    it("returns both catalogs and caches metadata within the credential generation", async () => {
        const vk = adapter("vk"),
            yandex = adapter("yandex");
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk, yandex],
        });
        const signal = new AbortController().signal;
        const result = await catalog.search("Song", signal);
        expect(result.tracks).toHaveLength(2);
        expect(result.unavailable).toEqual([]);
        expect(await catalog.search("Song", signal)).toEqual(result);
        expect(vk.search).toHaveBeenCalledTimes(1);
        vk.version++;
        await catalog.search("Song", signal);
        expect(vk.search).toHaveBeenCalledTimes(2);
        expect(yandex.search).toHaveBeenCalledTimes(1);
    });
    it("keeps healthy results when a provider requires a challenge and backs off", async () => {
        const vk = adapter("vk"),
            yandex = adapter("yandex");
        vk.search = jest.fn(async () => {
            throw new MusicSourceError("provider_challenge");
        });
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk, yandex],
        });
        expect(
            await catalog.search("Song", new AbortController().signal),
        ).toMatchObject({
            tracks: [expect.objectContaining({ provider: "yandex" })],
            unavailable: ["vk"],
        });
        await catalog.search("Other", new AbortController().signal);
        expect(vk.search).toHaveBeenCalledTimes(1);
    });
    it("bounds concurrent provider requests without retaining a queue", async () => {
        const vk = adapter("vk");
        let finish!: (rows: MusicSourceTrack[]) => void;
        vk.search = jest.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
            concurrency: 1,
        });
        const first = catalog.search("Song", new AbortController().signal);
        await Promise.resolve();
        await Promise.resolve();
        expect(
            await catalog.search("Other", new AbortController().signal),
        ).toEqual({ tracks: [], unavailable: ["vk"] });
        expect(vk.search).toHaveBeenCalledTimes(1);
        finish([track]);
        await first;
    });
    it("does not expose preview rows, wrong provider rows or duplicate identities", async () => {
        const vk = adapter("vk");
        vk.search = jest.fn(
            async (): Promise<MusicSourceTrack[]> => [
                track,
                track,
                { ...track, preview: true, id: "1_4" },
                { ...track, provider: "yandex" },
            ],
        );
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
        });
        expect(
            (await catalog.search("Song", new AbortController().signal)).tracks,
        ).toEqual([track]);
    });
    it("does not return cached tracks from a disabled connection", async () => {
        const vk = adapter("vk");
        const catalog = createMusicSourceCatalog({
            connections: async () => [vk],
        });
        await catalog.search("Song", new AbortController().signal);
        vk.enabled = false;
        expect(
            await catalog.search("Song", new AbortController().signal),
        ).toEqual({ tracks: [], unavailable: [] });
    });
    it("rejects invalid queries and an already cancelled request before provider work", async () => {
        const connections = jest.fn(async () => []);
        const catalog = createMusicSourceCatalog({ connections });
        await expect(
            catalog.search(" ", new AbortController().signal),
        ).rejects.toMatchObject({ code: "invalid_request" });
        await expect(
            catalog.search("Song", AbortSignal.abort()),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(connections).not.toHaveBeenCalled();
    });
});
