import express from "express";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { Registry } from "prom-client";
import request from "supertest";
import { createHttpRequestMetrics } from "../httpMetrics";
import { playRequestTrace } from "../../services/playRequestTrace";

describe("HTTP request metrics", () => {
    it("records a closed response once as cancelled rather than a successful default status", async () => {
        const registry = new Registry();
        const { middleware } = createHttpRequestMetrics(registry);
        const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
        middleware({method: "GET", originalUrl: "/api/library", baseUrl: "", route: {path: "/api/library"}} as Request, res as unknown as Response, () => {});
        res.emit("close");
        res.emit("finish");
        const exposition = await registry.metrics();
        expect(exposition).toContain('status_class="cancelled"} 1');
        expect(exposition).not.toContain('status_class="2xx"');
    });

    it("uses the engagement route template and finite stage labels for a private play ID", async () => {
        const registry = new Registry();
        const { middleware } = createHttpRequestMetrics(registry);
        const app = express();
        app.use(middleware);
        app.patch("/api/plays/:playId/engagement", async (_req, res) => {
            await playRequestTrace(res).write(async () => ({count: 1}));
            res.json({success: true});
        });
        const response = await request(app).patch("/api/plays/private-play-id/engagement");
        expect(response.headers["x-soundspan-play-write"]).toBe("committed");
        const exposition = await registry.metrics();
        expect(exposition).toContain('request_kind="engagement",path_kind="regular",stage="db_acquire_write"');
        expect(exposition).not.toContain("private-play-id");
    });
    it("exports play stages with finite labels across unique client IDs", async () => {
        const registry = new Registry();
        const { middleware } = createHttpRequestMetrics(registry);
        const app = express();
        app.use(middleware);
        app.post("/api/plays", async (_req, res) => {
            const trace = playRequestTrace(res);
            await trace.write(async () => "created");
            trace.respond();
            res.json({ id: "created" });
        });
        for (let index = 0; index < 12; index++) {
            const response = await request(app)
                .post("/api/plays")
                .set("X-Soundspan-Playback-Run", `private_run_${index}`)
                .set("X-Soundspan-Play-Attempt", `attempt_${index}`);
            expect(response.headers["x-soundspan-play-write"]).toBe(
                "committed",
            );
            expect(response.headers["x-soundspan-play-trace"]).toMatch(
                /^[a-f0-9-]{36}$/,
            );
        }
        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_play_request_stage_seconds_count{request_kind="create",path_kind="regular",stage="db_acquire_write",outcome="success",write_state="committed"} 12',
        );
        expect(exposition).not.toMatch(/private_run_|attempt_/);
    });
    it("records the Express route pattern without the resource id", async () => {
        const registry = new Registry();
        const { middleware } = createHttpRequestMetrics(registry);
        const app = express();
        const apiRouter = express.Router();
        app.use(middleware);
        apiRouter.get("/tracks/:trackId", (_req, res) => {
            res.status(200).json({ ok: true });
        });
        app.use("/api", apiRouter);

        await request(app).get("/api/tracks/abc123").expect(200);

        const exposition = await registry.metrics();
        expect(exposition).toContain('route_class="/api/tracks/:trackId"');
        expect(exposition).not.toContain("abc123");
        expect(exposition).toContain('status_class="2xx"');
    });

    it("collapses route patterns beyond the configured cardinality cap", async () => {
        const registry = new Registry();
        const { middleware } = createHttpRequestMetrics(registry, {
            maxRouteClasses: 1,
        });
        const app = express();
        app.use(middleware);
        app.get("/first/:id", (_req, res) => res.sendStatus(204));
        app.get("/second/:id", (_req, res) => res.sendStatus(204));

        await request(app).get("/first/one").expect(204);
        await request(app).get("/second/two").expect(204);

        const exposition = await registry.metrics();
        expect(exposition).toContain('route_class="/first/:id"');
        expect(exposition).toContain('route_class="other"');
        expect(exposition).not.toContain("one");
        expect(exposition).not.toContain("two");
    });
});
