import { Readable } from "node:stream";
import { createMusicSourceResolver } from "../musicSources/resolver";
import type {
    MusicSourceAdapter,
    MusicSourceTrack,
} from "../musicSources/types";

const recording: MusicSourceTrack = {
    provider: "vk",
    id: "1_2",
    title: "Song",
    artists: ["Artist"],
    duration: 180,
    contentVersion: "explicit",
    preview: false,
};
function fixture() {
    const source: MusicSourceAdapter = {
        provider: "vk",
        version: 1,
        enabled: true,
        search: jest.fn(async () => [recording, { ...recording, id: "1_3" }]),
        lookup: jest.fn(async () => recording),
        open: jest.fn(async () => ({
            status: 206,
            headers: { etag: '"song"', "content-range": "bytes 0-0/100" },
            data: Readable.from([Buffer.from("a")]),
        })),
    };
    return {
        source,
        resolver: createMusicSourceResolver({
            connections: async () => [source],
        }),
    };
}

describe("selected catalog recording", () => {
    it("resolves a stable source URL using only its exact provider identity", async () => {
        const { source, resolver } = fixture();
        expect(
            await resolver.resolve(
                "listener",
                null,
                new AbortController().signal,
                "vk",
                "1_2",
            ),
        ).toMatchObject({ provider: "vk" });
        expect(source.search).not.toHaveBeenCalled();
        await expect(
            resolver.resolve("listener", null, new AbortController().signal),
        ).rejects.toMatchObject({ code: "invalid_request" });
    });
    it("looks up the selected id instead of repeating ambiguous text search", async () => {
        const { source, resolver } = fixture();
        const lease = await resolver.resolve(
            "listener",
            recording,
            new AbortController().signal,
            "vk",
            "1_2",
        );
        expect(lease).toMatchObject({ provider: "vk" });
        expect(source.search).not.toHaveBeenCalled();
        expect(source.lookup).toHaveBeenCalledWith(
            "1_2",
            expect.any(AbortSignal),
        );
        expect(source.open).toHaveBeenCalledWith(
            "1_2",
            { range: "bytes=0-0" },
            expect.any(AbortSignal),
        );
    });
    it.each([
        { ...recording, id: "1_3" },
        { ...recording, title: "Song (Live)" },
        { ...recording, contentVersion: "unknown" as const },
        { ...recording, preview: true },
        null,
    ])(
        "does not play a replaced or unavailable selected recording",
        async (result) => {
            const { source, resolver } = fixture();
            source.lookup = jest.fn(async () => result);
            expect(
                await resolver.resolve(
                    "listener",
                    recording,
                    new AbortController().signal,
                    "vk",
                    "1_2",
                ),
            ).toBeNull();
            expect(source.search).not.toHaveBeenCalled();
            expect(source.open).not.toHaveBeenCalled();
        },
    );
    it("requires a provider when an exact id is supplied", async () => {
        const { source, resolver } = fixture();
        await expect(
            resolver.resolve(
                "listener",
                recording,
                new AbortController().signal,
                undefined,
                "1_2",
            ),
        ).rejects.toMatchObject({ code: "invalid_request" });
        expect(source.search).not.toHaveBeenCalled();
    });
});
