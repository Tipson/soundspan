import { createServer, type Server } from "node:http";
import { once } from "node:events";
import axios from "axios";
import { lookupRecordingLanguage } from "../recordingLanguageProvider";

describe("language metadata HTTP boundary", () => {
    let server: Server;
    let origin: string;
    let status = 200;
    let body = "{}";
    let contentType = "application/json";
    const urls: string[] = [];
    const track = {
        title: "Numb (Official Music Video)",
        artist: { name: "Linkin Park" },
        album: { title: "Meteora" },
        duration: 185,
    };
    beforeAll(async () => {
        server = createServer((req, res) => {
            urls.push(req.url ?? "");
            res.writeHead(status, {
                "Content-Type": contentType,
                ...(status === 302 ? { Location: `${origin}/redirect` } : {}),
            });
            res.end(body);
        }).listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Missing server address");
        origin = `http://127.0.0.1:${address.port}`;
    });
    beforeEach(() => {
        urls.length = 0;
        status = 200;
        body = "{}";
        contentType = "application/json";
        const get = axios.get.bind(axios);
        jest.spyOn(axios, "get").mockImplementation((url, config) => {
            expect(url).toBe("https://lrclib.net/api/get");
            expect(config?.timeout).toBe(8000);
            expect(config?.signal).toBeDefined();
            // Substitute only transport destination; the actual adapter retains
            // the production parsing, timeout, redirect and byte-limit policy.
            return get(`${origin}/api/get`, { ...config, proxy: false });
        });
    });
    afterEach(() => jest.restoreAllMocks());
    afterAll(async () => {
        server.close();
        await once(server, "close");
    });
    it("matches the real JSON response and sends encoded recording metadata", async () => {
        body = JSON.stringify({
            trackName: "Numb",
            artistName: "LINKIN PARK",
            duration: 186,
            instrumental: false,
            plainLyrics:
                "This is a story about a person who returns home every evening. He looks at the stars and remembers his childhood and his friends. Today he writes another letter about love, hope and the long road ahead.",
            syncedLyrics: null,
        });
        expect(await lookupRecordingLanguage(track)).toBe("foreign");
        expect(jest.mocked(axios.get).mock.calls[0][1]?.proxy).toBe(false);
        const params = new URL(urls[0], origin).searchParams;
        expect(params.get("track_name")).toBe("Numb");
        expect(params.get("artist_name")).toBe("Linkin Park");
        expect(urls).toHaveLength(1);
    });
    it("treats a missing recording as unknown, without retry", async () => {
        status = 404;
        expect(await lookupRecordingLanguage(track)).toBe("unknown");
        expect(urls).toHaveLength(1);
    });
    it("finds the same recording across album editions with one metadata request", async () => {
        // The catalog names The Gift Of Game, while the matched lyrics record
        // belongs to the Butterfly single. Album must not turn this into a miss.
        body = JSON.stringify({
            trackName: "Butterfly (Re-Recorded / Remastered )",
            artistName: "Crazy Town",
            albumName: "Butterfly",
            duration: 218,
            instrumental: false,
            plainLyrics:
                "This is a story about a person who returns home every evening. He looks at the stars and remembers his childhood and his friends. Today he writes another letter about love, hope and the long road ahead.",
            syncedLyrics: null,
        });
        expect(
            await lookupRecordingLanguage({
                title: "Butterfly (Re-Recorded / Remastered )",
                artist: { name: "Crazy Town" },
                album: { title: "The Gift Of Game" },
                duration: 218,
            }),
        ).toBe("foreign");
        const params = new URL(urls[0], origin).searchParams;
        expect(params.has("album_name")).toBe(false);
        expect(params.get("duration")).toBe("218");
        expect(params.get("track_name")).toBe(
            "Butterfly (Re-Recorded / Remastered )",
        );
        expect(urls).toHaveLength(1);
    });
    it.each([302, 429, 503])(
        "rejects HTTP %i without following redirects or retrying",
        async (code) => {
            status = code;
            await expect(lookupRecordingLanguage(track)).rejects.toThrow();
            expect(urls).toHaveLength(1);
        },
    );
    it("rejects oversized bodies and HTML responses", async () => {
        body = "x".repeat(256001);
        await expect(lookupRecordingLanguage(track)).rejects.toThrow();
        body = "<html>upstream unavailable</html>";
        contentType = "text/html";
        await expect(lookupRecordingLanguage(track)).rejects.toThrow(
            "Unexpected lyrics response type",
        );
    });
});
