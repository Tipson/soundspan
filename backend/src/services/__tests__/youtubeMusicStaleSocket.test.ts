import { once } from "node:events";
import http from "node:http";
import type { AxiosInstance } from "axios";

jest.mock("../../config", () => ({
    config: { ytmusicStreamer: { url: "http://127.0.0.1:1" } },
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));
import { ytMusicService } from "../youtubeMusic";

describe("stream transport reset before headers", () => {
    it.each([true, false])(
        "retries a reset reused socket once, recovery=%s",
        async (recover) => {
            let count = 0;
            const ranges: Array<string | undefined> = [];
            const sockets: unknown[] = [];
            const server = http.createServer((req, res) => {
                count++;
                ranges.push(req.headers.range);
                sockets.push(req.socket);
                if (count === 2 || (count === 3 && !recover)) {
                    req.socket.destroy();
                    return;
                }
                res.writeHead(206, {
                    "content-type": "audio/webm",
                    "content-range": "bytes 0-3/4",
                });
                res.end("test");
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address() as import("node:net").AddressInfo;
            const client = (
                ytMusicService as unknown as { client: AxiosInstance }
            ).client;
            const original = client.defaults.baseURL;
            client.defaults.baseURL = `http://127.0.0.1:${address.port}`;
            try {
                const read = async () => {
                    const response = await ytMusicService.getStreamProxy(
                        "__public__",
                        "test-video",
                        "high",
                        "bytes=0-3",
                        { timeoutMs: 2000 },
                    );
                    let body = "";
                    for await (const chunk of response.data)
                        body += chunk.toString();
                    return body;
                };
                expect(await read()).toBe("test");
                await new Promise((resolve) => setImmediate(resolve));
                if (recover) expect(await read()).toBe("test");
                else
                    await expect(read()).rejects.toMatchObject({
                        code: "ECONNRESET",
                    });
                expect(count).toBe(3);
                expect(sockets[0]).toBe(sockets[1]);
                expect(sockets[2]).not.toBe(sockets[1]);
                expect(ranges).toEqual(["bytes=0-3", "bytes=0-3", "bytes=0-3"]);
            } finally {
                client.defaults.baseURL = original;
                server.closeAllConnections();
                await new Promise<void>((resolve) =>
                    server.close(() => resolve()),
                );
            }
        },
    );

    it("does not retry a reset on a fresh socket", async () => {
        let count = 0;
        const server = http.createServer((req) => {
            count++;
            req.socket.destroy();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address() as import("node:net").AddressInfo;
        const client = (ytMusicService as unknown as { client: AxiosInstance })
            .client;
        const original = client.defaults.baseURL;
        client.defaults.baseURL = `http://127.0.0.1:${address.port}`;
        try {
            await expect(
                ytMusicService.getStreamProxy(
                    "__public__",
                    "fresh-video",
                    "high",
                    undefined,
                    { timeoutMs: 2000 },
                ),
            ).rejects.toMatchObject({ code: "ECONNRESET" });
            expect(count).toBe(1);
        } finally {
            client.defaults.baseURL = original;
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
