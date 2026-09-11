import { Readable } from "node:stream";
import { createMusicSourceAdapter } from "../musicSources/adapters";
import {
    isMusicSourceUrlAllowed,
    validateMusicRange,
} from "../musicSources/transport";

const signal = () => new AbortController().signal;
const recording = {
    id: "123",
    title: "Пьяная",
    artists: [{ name: "Папин Олимпос" }],
    durationMs: 159000,
    available: true,
    contentWarning: "explicit",
};
function http() {
    return {
        json: jest.fn(),
        text: jest.fn(),
        stream: jest.fn(async () => ({
            status: 206,
            headers: { "content-type": "audio/mpeg" },
            data: Readable.from(["test"]),
        })),
    };
}
describe("music source adapters", () => {
    it("maps Yandex metadata and sends credentials only to its API", async () => {
        const port = http();
        port.json.mockResolvedValue({
            result: { tracks: { results: [recording] } },
        });
        const source = createMusicSourceAdapter(
            "yandex",
            "service-secret",
            1,
            port,
        );
        expect(await source.search("Пьяная", signal())).toEqual([
            {
                provider: "yandex",
                id: "123",
                title: "Пьяная",
                artists: ["Папин Олимпос"],
                duration: 159,
                contentVersion: "explicit",
                preview: false,
            },
        ]);
        expect(port.json.mock.calls[0][1]).toEqual({
            Authorization: "OAuth service-secret",
        });
    });
    it("builds Yandex media checksum without leading slash and rejects preview-only downloads", async () => {
        const port = http();
        port.json.mockResolvedValue({
            result: [
                {
                    codec: "mp3",
                    bitrateInKbps: 192,
                    preview: false,
                    downloadInfoUrl: "https://storage.mds.yandex.net/info",
                },
            ],
        });
        port.text.mockResolvedValue(
            "<download-info><host>storage.mds.yandex.net</host><path>/abc</path><ts>123</ts><s>xyz</s></download-info>",
        );
        const source = createMusicSourceAdapter(
            "yandex",
            "service-secret",
            1,
            port,
        );
        const response = await source.open(
            "123",
            { range: "bytes=0-9" },
            signal(),
        );
        response.data.destroy();
        const { createHash } = await import("node:crypto");
        const checksum = createHash("md5")
            .update("XGRlBW9FXlekgbPrRHuSiAabcxyz")
            .digest("hex");
        expect(port.stream.mock.calls[0]).toEqual([
            `https://storage.mds.yandex.net/get-mp3/${checksum}/123/abc`,
            "yandex",
            { range: "bytes=0-9" },
            expect.any(AbortSignal),
        ]);
        expect(port.text.mock.calls[0][0]).not.toContain("service-secret");
        port.json.mockResolvedValue({
            result: [
                {
                    codec: "mp3",
                    bitrateInKbps: 192,
                    preview: true,
                    downloadInfoUrl: "https://storage.mds.yandex.net/info",
                },
            ],
        });
        await expect(source.open("123", {}, signal())).rejects.toMatchObject({
            code: "entitlement_required",
        });
    });
    it("does not map unmarked songs to explicitly clean versions", async () => {
        const port = http();
        port.json.mockResolvedValue({
            result: [{ ...recording, contentWarning: undefined }],
        });
        const source = createMusicSourceAdapter(
            "yandex",
            "service-secret",
            1,
            port,
        );
        expect((await source.lookup("123", signal()))!.contentVersion).toBe(
            "unknown",
        );
    });
    it("maps VK identity and fails on a provider challenge without replaying it", async () => {
        const port = http();
        port.json.mockResolvedValue({
            response: {
                items: [
                    {
                        id: 456,
                        owner_id: -200,
                        title: "Song",
                        artist: "Artist",
                        duration: 180,
                        is_explicit: true,
                    },
                ],
            },
        });
        const source = createMusicSourceAdapter(
            "vk",
            "service-secret",
            1,
            port,
        );
        const found = await source.search("Song", signal());
        expect(found[0]).toMatchObject({
            provider: "vk",
            id: "-200_456",
            contentVersion: "explicit",
            duration: 180,
        });
        expect(port.json.mock.calls[0][0]).not.toContain("service-secret");
        expect(port.json.mock.calls[0][1]).toEqual({});
        expect(port.json.mock.calls[0][3]).toEqual({
            access_token: "service-secret",
        });
        port.json.mockResolvedValue({
            error: { error_code: 14, captcha_sid: "private" },
        });
        await expect(source.search("Song", signal())).rejects.toMatchObject({
            code: "provider_challenge",
        });
        expect(port.json).toHaveBeenCalledTimes(2);
    });
    it("rejects malformed IDs and arbitrary upstream URLs before network access", async () => {
        const port = http();
        const source = createMusicSourceAdapter(
            "yandex",
            "service-secret",
            1,
            port,
        );
        await expect(
            source.open("../account/status", {}, signal()),
        ).rejects.toMatchObject({ code: "invalid_request" });
        expect(port.json).not.toHaveBeenCalled();
        port.json.mockResolvedValue({
            result: [
                {
                    codec: "mp3",
                    bitrateInKbps: 192,
                    preview: false,
                    downloadInfoUrl: "https://evil.example/?secret",
                },
            ],
        });
        await expect(source.open("123", {}, signal())).rejects.toMatchObject({
            code: "unsupported_stream",
        });
        expect(port.text).not.toHaveBeenCalled();
    });
    it.each([
        "http://storage.mds.yandex.net/a",
        "https://user:pass@storage.mds.yandex.net/a",
        "https://storage.mds.yandex.net.evil.test/a",
        "https://127.0.0.1/a",
        "https://storage.mds.yandex.net:444/a",
    ])("rejects unsafe URL %s", (url) => {
        expect(isMusicSourceUrlAllowed(url, "yandex")).toBe(false);
    });
    it("only permits one valid byte range", () => {
        for (const range of ["bytes=0-", "bytes=100-200", "bytes=-100"])
            expect(validateMusicRange(range)).toBe(true);
        for (const range of [
            "bytes=0-1,3-4",
            "bytes=2-1",
            "bytes=-0",
            "bytes=-",
            "bytes=999999999999999999-",
            "bytes=0-\r\nfoo",
        ])
            expect(validateMusicRange(range)).toBe(false);
    });
});
