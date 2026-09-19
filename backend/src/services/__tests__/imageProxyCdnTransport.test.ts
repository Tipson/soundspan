import { Readable } from "node:stream";
import axios from "axios";
import { lookup } from "dns/promises";
import { fetchExternalImage } from "../imageProxy";

jest.mock("axios", () => ({ get: jest.fn() }));
jest.mock("dns/promises", () => ({
    lookup: jest
        .fn()
        .mockResolvedValue([{ address: "142.250.1.1", family: 4 }]),
}));

describe("YouTube image transport", () => {
    const originalFetch = global.fetch;
    const url = "https://yt3.googleusercontent.com/cover=w544";
    const get = jest.mocked(axios.get);
    const response = (
        status = 200,
        headers: Record<string, string> = { "content-type": "image/jpeg" },
        body = Readable.from([Buffer.from("image-bytes")]),
    ) => ({ status, statusText: "", headers, data: body });

    beforeEach(() => {
        jest.clearAllMocks();
        jest.mocked(lookup).mockResolvedValue([
            { address: "142.250.1.1", family: 4 },
        ] as never);
        global.fetch = jest.fn().mockRejectedValue(new Error("direct timeout"));
        get.mockResolvedValue(response());
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("streams an approved CDN using the proxy-aware HTTP adapter", async () => {
        const result = await fetchExternalImage({
            url,
            maxRetries: 1,
            timeoutMs: 500,
        });
        expect(result).toMatchObject({
            ok: true,
            buffer: Buffer.from("image-bytes"),
        });
        expect(get).toHaveBeenCalledWith(
            url,
            expect.objectContaining({
                adapter: "http",
                responseType: "stream",
                maxRedirects: 0,
                signal: expect.any(AbortSignal),
            }),
        );
        // Undefined proxy retains Axios HTTPS_PROXY / NO_PROXY handling.
        expect(get.mock.calls[0][1]?.proxy).toBeUndefined();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each([
        "https://yt3.googleusercontent.com.attacker.example/cover",
        "https://attacker.googleusercontent.com/cover",
        "https://yt3.googleusercontent.com:8443/cover",
        "http://yt3.googleusercontent.com/cover",
        "https://user:secret@yt3.googleusercontent.com/cover",
    ])("does not expand proxy trust to %s", async (otherUrl) => {
        await fetchExternalImage({ url: otherUrl, maxRetries: 1 });
        expect(get).not.toHaveBeenCalled();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects a private DNS result before the CDN request", async () => {
        jest.mocked(lookup).mockResolvedValue([
            { address: "127.0.0.1", family: 4 },
        ] as never);
        expect(await fetchExternalImage({ url, maxRetries: 1 })).toMatchObject({
            ok: false,
            status: "invalid_url",
        });
        expect(get).not.toHaveBeenCalled();
    });

    it("blocks a redirect to an internal address and cancels the body", async () => {
        const upstream = response(302, {
            location: "http://127.0.0.1/private",
        });
        get.mockResolvedValue(upstream);
        expect(await fetchExternalImage({ url, maxRetries: 1 })).toMatchObject({
            ok: false,
            status: "invalid_url",
        });
        expect(get).toHaveBeenCalledTimes(1);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(upstream.data.destroyed).toBe(true);
    });

    it("reselects transport after a validated redirect outside the CDN list", async () => {
        get.mockResolvedValue(
            response(302, { location: "https://example.com/cover" }),
        );
        global.fetch = jest
            .fn()
            .mockResolvedValue(new Response("redirect-image"));
        expect(await fetchExternalImage({ url, maxRetries: 1 })).toMatchObject({
            ok: true,
            url: "https://example.com/cover",
            buffer: Buffer.from("redirect-image"),
        });
        expect(get).toHaveBeenCalledTimes(1);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("enforces the byte cap on the proxied stream and stops upstream", async () => {
        const body = new Readable({
            read() {
                this.push(Buffer.alloc(8));
            },
        });
        get.mockResolvedValue(response(200, {}, body));
        expect(
            await fetchExternalImage({ url, maxRetries: 1, maxBytes: 4 }),
        ).toMatchObject({
            ok: false,
            status: "fetch_error",
            message: "External image exceeds maximum size",
        });
        expect(body.destroyed).toBe(true);
    });

    it("does not retry a missing CDN image", async () => {
        get.mockResolvedValue(response(404));
        expect(await fetchExternalImage({ url, maxRetries: 3 })).toMatchObject({
            ok: false,
            status: "not_found",
        });
        expect(get).toHaveBeenCalledTimes(1);
    });

    it("keeps the deadline active while reading a stalled response body", async () => {
        const body = new Readable({ read() {} });
        get.mockImplementationOnce(async (_url, options) => {
            options?.signal?.addEventListener?.(
                "abort",
                () => body.destroy(new Error("aborted")),
                { once: true },
            );
            return response(200, {}, body);
        });
        expect(
            await fetchExternalImage({ url, maxRetries: 1, timeoutMs: 100 }),
        ).toMatchObject({
            ok: false,
            status: "fetch_error",
            message: "aborted",
        });
        expect(body.destroyed).toBe(true);
    });

    it.each([204, 205, 304])(
        "closes a bodyless HTTP %i response stream",
        async (status) => {
            const upstream = response(status);
            get.mockResolvedValue(upstream);
            await fetchExternalImage({ url, maxRetries: 1 });
            expect(upstream.data.destroyed).toBe(true);
            expect(get).toHaveBeenCalledTimes(1);
        },
    );
});
