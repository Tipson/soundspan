import { Readable } from "node:stream";
import axios from "axios";
import { lookup } from "node:dns/promises";
import { musicSourceHttp } from "../musicSources/transport";

jest.mock("axios", () => ({
    __esModule: true,
    default: { request: jest.fn() },
}));
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
const request = axios.request as jest.Mock;
const dns = lookup as jest.Mock;
const signal = () => new AbortController().signal;
const url = "https://cdn.userapi.com/song.mp3?signed=private";
function response(
    status = 206,
    headers: Record<string, string | undefined> = {},
) {
    return {
        status,
        headers: {
            "content-type": "audio/mpeg",
            "content-length": "3",
            "content-range": "bytes 0-2/3",
            etag: '"one"',
            ...headers,
        },
        data: Readable.from([Buffer.from("abc")]),
    };
}
beforeEach(() => {
    dns.mockReset().mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    request.mockReset();
});

describe("music source transport", () => {
    it.each([
        "127.0.0.1",
        "10.1.1.1",
        "169.254.169.254",
        "::ffff:127.0.0.1",
        "::1",
    ])("blocks private DNS answer %s before HTTP", async (address) => {
        dns.mockResolvedValue([
            { address, family: address.includes(":") ? 6 : 4 },
        ]);
        await expect(
            musicSourceHttp.stream(url, "vk", {}, signal()),
        ).rejects.toMatchObject({ code: "unsupported_stream" });
        expect(request).not.toHaveBeenCalled();
    });
    it("pins the checked DNS address and never forwards credentials to a media redirect", async () => {
        const redirect = response(302, {
            location: "https://other.userapi.com/media",
        });
        request
            .mockResolvedValueOnce(redirect)
            .mockResolvedValueOnce(response());
        const result = await musicSourceHttp.stream(
            url,
            "vk",
            { range: "bytes=0-2" },
            signal(),
        );
        const chunks = [];
        for await (const chunk of result.data) chunks.push(chunk);
        expect(Buffer.concat(chunks).toString()).toBe("abc");
        for (const [options] of request.mock.calls) {
            expect(options).toMatchObject({
                maxRedirects: 0,
                proxy: false,
                headers: { "Accept-Encoding": "identity", Range: "bytes=0-2" },
            });
            expect(options.headers.Authorization).toBeUndefined();
            await new Promise<void>((resolve) =>
                options.httpsAgent.options.lookup(
                    "other.example",
                    { family: 4 },
                    (_err: unknown, address: string) => {
                        expect(address).toBe("1.1.1.1");
                        resolve();
                    },
                ),
            );
        }
        expect(dns).toHaveBeenCalledTimes(2);
        expect(redirect.data.destroyed).toBe(true);
    });
    it("does not follow a media redirect to an arbitrary host", async () => {
        request.mockResolvedValue(
            response(302, { location: "https://evil.example/" }),
        );
        await expect(
            musicSourceHttp.stream(url, "vk", {}, signal()),
        ).rejects.toMatchObject({ code: "unsupported_stream" });
        expect(request).toHaveBeenCalledTimes(1);
    });
    it.each([
        { "content-range": "bytes 2-1/3" },
        { "content-range": "bytes 0-3/3", "content-length": "4" },
        { "content-range": "bytes 1-2/3", "content-length": "2" },
        { "content-range": "bytes 0-2/3", "content-length": "99" },
        { "content-range": "bytes 0-2/999999999999999999999" },
        { "content-length": "-1" },
        { "content-type": "text/html" },
        { "content-encoding": "gzip" },
    ])(
        "rejects malformed or incompatible media headers %j",
        async (headers) => {
            const upstream = response(206, headers);
            request.mockResolvedValue(upstream);
            await expect(
                musicSourceHttp.stream(
                    url,
                    "vk",
                    { range: "bytes=0-2" },
                    signal(),
                ),
            ).rejects.toMatchObject({ code: "unsupported_stream" });
            expect(upstream.data.destroyed).toBe(true);
        },
    );
    it("reports an incomplete body as an error instead of successful EOF", async () => {
        const upstream = response(200, { "content-length": "5" });
        request.mockResolvedValue(upstream);
        const result = await musicSourceHttp.stream(url, "vk", {}, signal());
        await expect(
            (async () => {
                for await (const _chunk of result.data) {
                    /* drain */
                }
            })(),
        ).rejects.toMatchObject({ code: "unavailable" });
    });
    it("preserves a valid unsatisfiable range without forwarding its body", async () => {
        request.mockResolvedValue(
            response(416, { "content-range": "bytes */3" }),
        );
        const result = await musicSourceHttp.stream(
            url,
            "vk",
            { range: "bytes=50-" },
            signal(),
        );
        expect(result.status).toBe(416);
        expect(result.headers).toEqual({
            "content-range": "bytes */3",
            "content-length": "0",
        });
    });
    it("sends VK credentials as a POST form and refuses API redirects", async () => {
        request.mockResolvedValue({
            status: 200,
            headers: {},
            data: { response: [] },
        });
        await musicSourceHttp.json(
            "https://api.vk.com/method/audio.search?v=5.199",
            {},
            signal(),
            { access_token: "secret" },
        );
        const options = request.mock.calls[0][0];
        expect(options.method).toBe("POST");
        expect(options.data.get("access_token")).toBe("secret");
        expect(options.url).not.toContain("secret");
        request.mockResolvedValue({
            status: 302,
            headers: { location: "https://evil.example" },
        });
        await expect(
            musicSourceHttp.json(
                "https://api.music.yandex.net/search",
                { Authorization: "OAuth secret" },
                signal(),
            ),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect(request).toHaveBeenCalledTimes(2);
    });
});
