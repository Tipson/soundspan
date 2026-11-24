import { createRequire } from "node:module";
import express from "express";
import { rateLimit } from "express-rate-limit";
import request from "supertest";

// Exercise the exact transitive dependency Express uses, including nested installs.
const expressRequire = createRequire(require.resolve("express"));
const proxyaddr = expressRequire("proxy-addr") as {
    compile: (subnet: string) => (address: string) => boolean;
};

describe("proxy-addr IPv4-mapped IPv6 trust boundary", () => {
    it.each(["::ffff:10.0.0.0/8", "::/1"])(
        "does not trust an IPv4 client through the IPv6 subnet %s",
        (subnet) => {
            const trust = proxyaddr.compile(subnet);
            expect(trust("198.51.100.25")).toBe(false);
            expect(trust("::ffff:198.51.100.25")).toBe(false);
        },
    );

    it("preserves genuine mapped IPv4 and native IPv6 subnet matching", () => {
        const mapped = proxyaddr.compile("::ffff:10.0.0.0/104");
        expect(mapped("10.1.2.3")).toBe(true);
        expect(mapped("::ffff:10.1.2.3")).toBe(true);
        expect(mapped("198.51.100.25")).toBe(false);

        const native = proxyaddr.compile("2001:db8::/32");
        expect(native("2001:db8::1234")).toBe(true);
        expect(native("2001:db9::1234")).toBe(false);
    });

    it("does not accept a forged Express client IP through a short mapped trust subnet", async () => {
        const app = express();
        app.set("trust proxy", "::ffff:10.0.0.0/8");
        app.get("/identity", (req, res) => {
            res.json({ ip: req.ip, peer: req.socket.remoteAddress });
        });

        const response = await request(app)
            .get("/identity")
            .set("X-Forwarded-For", "198.51.100.99")
            .expect(200);

        expect(response.body.ip).toBe(response.body.peer);
    });
});

describe("Express trust for a preserving frontend proxy chain", () => {
    it("resolves the edge-appended client without trusting the preserved extra prefix", async () => {
        const app = express();
        app.set("trust proxy", 1);
        app.get("/identity", (req, res) => {
            res.json({ ip: req.ip, ips: req.ips });
        });

        const response = await request(app)
            .get("/identity")
            .set("X-Forwarded-For", "198.51.100.99, 203.0.113.10")
            .expect(200);

        expect(response.body).toEqual({
            ip: "203.0.113.10",
            ips: ["203.0.113.10"],
        });
    });

    it("keeps one rate-limit bucket when a client changes the untrusted XFF prefix", async () => {
        const app = express();
        app.set("trust proxy", 1);
        app.use(rateLimit({ windowMs: 60_000, limit: 1 }));
        app.get("/limited", (_req, res) => res.sendStatus(200));

        await request(app)
            .get("/limited")
            .set("X-Forwarded-For", "198.51.100.1, 203.0.113.10")
            .expect(200);
        await request(app)
            .get("/limited")
            .set("X-Forwarded-For", "198.51.100.2, 203.0.113.10")
            .expect(429);
        await request(app)
            .get("/limited")
            .set("X-Forwarded-For", "198.51.100.2, 203.0.113.11")
            .expect(200);
    });
});
