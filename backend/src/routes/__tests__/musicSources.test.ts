import express from "express";
import request from "supertest";
import { PassThrough } from "node:stream";
import { get } from "node:http";
import {
    musicSourceResolver,
    musicSourceCatalog,
} from "../../services/musicSources/runtime";
import { MusicSourceError } from "../../services/musicSources/types";
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, res: any, next: any) => {
        if (!req.headers["x-user"]) return res.sendStatus(401);
        req.user = {
            id: req.headers["x-user"],
            role: req.headers["x-role"] ?? "user",
        };
        next();
    },
    requireAuthOrToken: (req: any, res: any, next: any) => {
        if (!req.headers["x-user"]) return res.sendStatus(401);
        req.user = {
            id: req.headers["x-user"],
            role: req.headers["x-role"] ?? "user",
        };
        next();
    },
    requireAdmin: (req: any, res: any, next: any) =>
        req.user.role === "admin" ? next() : res.sendStatus(403),
}));
jest.mock("../../services/musicSources/connections", () => ({
    listMusicSourceConnections: jest.fn(async () => []),
    saveMusicSourceConnection: jest.fn(),
    loadMusicSourceAdapters: jest.fn(async () => []),
}));
import router from "../musicSources";
import { saveMusicSourceConnection } from "../../services/musicSources/connections";
const app = express();
app.use(express.json());
app.use("/api/music-sources", router);
describe("music sources HTTP boundary", () => {
    it("renews a stable recording stream through a private owned lease", async () => {
        const leaseId = "b".repeat(48);
        const spy = jest
            .spyOn(musicSourceResolver, "resolve")
            .mockResolvedValue({
                provider: "vk",
                leaseId,
                expiresAt: Date.now() + 60_000,
                streamPath: `/api/music-sources/leases/${leaseId}/stream`,
            });
        try {
            await request(app)
                .get("/api/music-sources/recordings/vk/1_2/stream")
                .expect(401);
            const response = await request(app)
                .get("/api/music-sources/recordings/vk/1_2/stream")
                .set("x-user", "stable-recording")
                .expect(307);
            expect(response.headers.location).toBe(
                `/api/music-sources/leases/${leaseId}/stream`,
            );
            expect(spy).toHaveBeenCalledWith(
                "stable-recording",
                null,
                expect.any(AbortSignal),
                "vk",
                "1_2",
            );
            await request(app)
                .get("/api/music-sources/recordings/yandex/1_2/stream")
                .set("x-user", "stable-recording")
                .expect(400);
        } finally {
            spy.mockRestore();
        }
    });
    it("allows authenticated catalog exploration without granting connection access", async () => {
        const spy = jest
            .spyOn(musicSourceCatalog, "search")
            .mockResolvedValue({ tracks: [], unavailable: ["vk"] });
        try {
            await request(app)
                .get("/api/music-sources/catalog?query=Song")
                .expect(401);
            const response = await request(app)
                .get("/api/music-sources/catalog?query=Song")
                .set("x-user", "catalog-user")
                .expect(200);
            expect(response.body).toEqual({ tracks: [], unavailable: ["vk"] });
            expect(spy).toHaveBeenCalledWith("Song", expect.any(AbortSignal));
            await request(app)
                .get("/api/music-sources/connections")
                .set("x-user", "catalog-user")
                .expect(403);
            await request(app)
                .get("/api/music-sources/catalog?query=")
                .set("x-user", "catalog-user")
                .expect(400);
        } finally {
            spy.mockRestore();
        }
    });
    it("passes a selected provider identity to the resolver", async () => {
        const spy = jest
            .spyOn(musicSourceResolver, "resolve")
            .mockResolvedValue(null);
        try {
            await request(app)
                .post("/api/music-sources/resolve")
                .set("x-user", "selection")
                .send({
                    provider: "vk",
                    providerTrackId: "1_2",
                    title: "Song",
                    artists: ["Artist"],
                    duration: 180,
                    contentVersion: "explicit",
                })
                .expect(200);
            expect(spy).toHaveBeenCalledWith(
                "selection",
                expect.objectContaining({ title: "Song" }),
                expect.any(AbortSignal),
                "vk",
                "1_2",
            );
        } finally {
            spy.mockRestore();
        }
    });
    it.each([
        { providerTrackId: "1_2" },
        { provider: "yandex", providerTrackId: "1_2" },
        { provider: "vk", providerTrackId: "https://internal/" },
    ])("rejects an invalid selected identity", async (identity) => {
        await request(app)
            .post("/api/music-sources/resolve")
            .set("x-user", "invalid-selection")
            .send({
                ...identity,
                title: "Song",
                artists: ["Artist"],
                duration: 180,
                contentVersion: "unknown",
            })
            .expect(400);
    });
    it("requires authentication and admin privileges to configure a shared account", async () => {
        await request(app).get("/api/music-sources/connections").expect(401);
        await request(app)
            .get("/api/music-sources/connections")
            .set("x-user", "a")
            .expect(403);
        await request(app)
            .put("/api/music-sources/connections/vk")
            .set("x-user", "a")
            .send({ token: "secret", enabled: true })
            .expect(403);
        expect(saveMusicSourceConnection).not.toHaveBeenCalled();
    });
    it("accepts an admin update without returning secrets", async () => {
        const r = await request(app)
            .put("/api/music-sources/connections/vk")
            .set("x-user", "a")
            .set("x-role", "admin")
            .send({ token: "own-service-token", enabled: false })
            .expect(200);
        expect(r.body).toEqual({ saved: true });
        expect(saveMusicSourceConnection).toHaveBeenCalledWith("vk", {
            token: "own-service-token",
            enabled: false,
        });
    });
    it("rejects arbitrary providers, raw URLs and malformed recordings", async () => {
        await request(app)
            .put("/api/music-sources/connections/evil")
            .set("x-user", "a")
            .set("x-role", "admin")
            .send({ token: "secret", enabled: true })
            .expect(400);
        await request(app)
            .post("/api/music-sources/resolve")
            .set("x-user", "a")
            .send({ url: "https://127.0.0.1" })
            .expect(400);
        await request(app)
            .get("/api/music-sources/leases/abc/stream")
            .set("x-user", "a")
            .expect(404);
    });
    it("returns no candidate when no service accounts are enabled", async () => {
        const r = await request(app)
            .post("/api/music-sources/resolve")
            .set("x-user", "a")
            .send({
                title: "Song",
                artists: ["Artist"],
                duration: 180,
                contentVersion: "unknown",
            })
            .expect(200);
        expect(r.body).toEqual({ playback: null });
    });
    it.each(["error", "close"])(
        "closes a started stream after upstream %s without replacing sent headers",
        async (mode) => {
            const stream = new PassThrough();
            const spy = jest
                .spyOn(musicSourceResolver, "open")
                .mockResolvedValue({
                    status: 200,
                    headers: {
                        "content-type": "audio/mpeg",
                        "content-length": "100",
                    },
                    data: stream,
                });
            const server = app.listen(0, "127.0.0.1");
            await new Promise<void>((resolve) =>
                server.once("listening", resolve),
            );
            let handlerError: unknown;
            try {
                await new Promise<void>((resolve, reject) => {
                    const address = server.address() as { port: number };
                    const client = get(
                        `http://127.0.0.1:${address.port}/api/music-sources/leases/${"a".repeat(48)}/stream`,
                        { headers: { "x-user": "a" } },
                        (res) => {
                            res.once("data", () => {
                                const deadline = setTimeout(() => {
                                    handlerError = new Error(
                                        "HTTP response stayed open after upstream closed",
                                    );
                                    client.destroy();
                                }, 200);
                                res.once("close", () => clearTimeout(deadline));
                                try {
                                    if (mode === "close") stream.destroy();
                                    else
                                        stream.emit(
                                            "error",
                                            new MusicSourceError("unavailable"),
                                        );
                                } catch (error) {
                                    handlerError = error;
                                    client.destroy();
                                }
                            });
                            res.on("error", () => {});
                            res.once("close", resolve);
                        },
                    );
                    client.on("error", reject);
                    setTimeout(() => stream.write(Buffer.from("abc")), 20);
                });
                expect(handlerError).toBeUndefined();
            } finally {
                stream.destroy();
                spy.mockRestore();
                await new Promise<void>((resolve) =>
                    server.close(() => resolve()),
                );
            }
        },
    );
});
