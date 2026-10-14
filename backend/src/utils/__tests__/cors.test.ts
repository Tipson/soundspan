import { isOriginAllowed, playbackStateCorsOptions } from "../cors";
import cors from "cors";
import express from "express";
import request from "supertest";

it("exposes playback leases and allows conditional browser requests", async () => {
    const app = express().use(
        cors({ origin: true, credentials: true, ...playbackStateCorsOptions }),
    );
    app.get("/", (_req, res) =>
        res
            .set({ ETag: '"ps1.absent"', "X-Playback-State-Protocol": "1" })
            .json(null),
    );
    const response = await request(app)
        .get("/")
        .set("Origin", "https://player.example");
    const exposed = response.headers["access-control-expose-headers"]
        ?.toLowerCase()
        .split(",");
    expect(exposed).toEqual(
        expect.arrayContaining(["etag", "x-playback-state-protocol"]),
    );
    const preflight = await request(app)
        .options("/")
        .set("Origin", "https://player.example")
        .set("Access-Control-Request-Method", "POST")
        .set(
            "Access-Control-Request-Headers",
            "Content-Type,If-Match,X-Playback-Device-Id",
        );
    expect(preflight.status).toBe(204);
    expect(
        preflight.headers["access-control-allow-headers"].toLowerCase(),
    ).toContain("if-match");
});

describe("isOriginAllowed", () => {
    it("allows requests with no origin (same-origin, curl, server-to-server)", () => {
        expect(isOriginAllowed(undefined, [], "production")).toBe(true);
        expect(isOriginAllowed("", ["https://app.example"], "production")).toBe(
            true,
        );
    });

    it("denies cross-origin requests when no allowlist is configured (deny-by-default)", () => {
        // Production posture: an unconfigured allowlist must NOT reflect
        // arbitrary origins while credentials are enabled. Operators opt back
        // into the legacy permissive behavior with CORS_ALLOW_ALL=true, which
        // config.ts resolves to `allowedOrigins: true`.
        expect(
            isOriginAllowed("https://anything.example", [], "production"),
        ).toBe(false);
        expect(isOriginAllowed("https://anything.example", [], "test")).toBe(
            false,
        );
    });

    it("allows all origins when explicitly set to true or in development", () => {
        // `true` is the resolved CORS_ALLOW_ALL / legacy opt-out value.
        expect(
            isOriginAllowed("https://anything.example", true, "production"),
        ).toBe(true);
        expect(
            isOriginAllowed("https://anything.example", [], "development"),
        ).toBe(true);
    });

    it("enforces a configured allowlist: allows listed origins", () => {
        expect(
            isOriginAllowed(
                "https://app.example",
                ["https://app.example", "https://admin.example"],
                "production",
            ),
        ).toBe(true);
    });

    it("enforces a configured allowlist: denies unlisted origins", () => {
        expect(
            isOriginAllowed(
                "https://evil.example",
                ["https://app.example"],
                "production",
            ),
        ).toBe(false);
    });
});
