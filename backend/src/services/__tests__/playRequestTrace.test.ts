import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { createPlayRequestTrace } from "../playRequestTrace";

describe("play request stage attribution", () => {
    function fixture(diagnostic = false, headers: Record<string, unknown> = {}) {
        let now = 0;
        const records: any[] = [];
        const logs: any[] = [];
        const response = Object.assign(new EventEmitter(), {
            locals: {},
            statusCode: 200,
            writableFinished: false,
            setHeader: jest.fn(),
            writeHead: jest.fn(),
        }) as unknown as Response;
        const req = {
            method: "POST",
            originalUrl: "/api/plays?token=never-log",
            headers: {
                "x-soundspan-playback-run": "run_1",
                "x-soundspan-play-attempt": "attempt_1",
                ...(diagnostic ? { "x-soundspan-diagnostic": "playback" } : {}),
                ...headers,
            },
        } as unknown as Request;
        const trace = createPlayRequestTrace(req, response, {
            now: () => now,
            record: (record) => records.push(record),
            log: (event, fields) => logs.push({ event, ...fields }),
        })!;
        return {
            trace,
            response,
            records,
            logs,
            advance: (ms: number) => {
                now += ms;
            },
        };
    }

    it("distinguishes cancellation before write from late committed write", async () => {
        const before = fixture();
        before.advance(20);
        before.response.emit("close");
        expect(before.records.at(-1)).toMatchObject({
            stage: "request",
            outcome: "cancelled",
            writeState: "not_started",
            durationMs: 20,
        });

        const during = fixture();
        let commit!: (value: string) => void;
        const write = during.trace.write(
            () =>
                new Promise<string>((resolve) => {
                    commit = resolve;
                }),
        );
        during.advance(30);
        during.response.emit("close");
        expect(during.records.at(-1)).toMatchObject({
            stage: "request",
            outcome: "cancelled",
            writeState: "inflight",
        });
        during.advance(40);
        commit("play-1");
        await expect(write).resolves.toBe("play-1");
        expect(during.records.at(-1)).toMatchObject({
            stage: "db_acquire_write",
            outcome: "late_success",
            writeState: "committed",
            durationMs: 70,
        });
        expect(
            during.records.filter((row) => row.stage === "request"),
        ).toHaveLength(1);
    });

    it("reports after-commit attribution timeout and terminal finish once", async () => {
        const f = fixture();
        await f.trace.write(async () => "play-1");
        let attribute!: () => void;
        const attribution = f.trace.measure(
            "attribution",
            () =>
                new Promise<void>((resolve) => {
                    attribute = resolve;
                }),
        );
        f.advance(20000);
        f.response.emit("close");
        expect(f.records.at(-1)).toMatchObject({
            stage: "request",
            activeStage: "attribution",
            outcome: "cancelled",
            writeState: "committed",
        });
        attribute();
        await attribution;
        f.response.emit("finish");
        expect(f.records.filter((row) => row.stage === "request")).toHaveLength(
            1,
        );
        expect(f.records.at(-1)).toMatchObject({
            stage: "attribution",
            outcome: "late_success",
        });
    });

    it("times response headers when Node writes them, after response preparation", () => {
        const f = fixture();
        f.trace.respond();
        f.advance(42);
        f.response.writeHead(200);
        expect(f.records.find((row) => row.stage === "response_headers")).toMatchObject({durationMs: 42});
    });

    it("times independent stages and never includes paths or arbitrary IDs in metric records", async () => {
        const f = fixture(true);
        await f.trace.measure("validation", async () => {
            f.advance(7);
        });
        f.trace.respond();
        f.response.emit("finish");
        expect(f.records[0]).toMatchObject({
            stage: "validation",
            durationMs: 7,
            pathKind: "diagnostic",
        });
        expect(JSON.stringify(f.records)).not.toMatch(
            /run_1|attempt_1|token|never-log/,
        );
        expect(f.logs[0]).toMatchObject({
            playbackRunId: "run_1",
            clientAttemptId: "attempt_1",
        });
        expect(JSON.stringify(f.logs)).not.toMatch(/token|never-log/);
    });

    it("keeps rejection ambiguous and rejects unbounded correlation IDs", async () => {
        const f = fixture();
        await expect(
            f.trace.write(async () => {
                throw new Error("secret-db-string");
            }),
        ).rejects.toThrow("secret-db-string");
        f.response.emit("close");
        expect(f.records.at(-1)).toMatchObject({ writeState: "unknown" });
        expect(JSON.stringify(f.logs)).not.toContain("secret-db-string");
    });

    it("omits oversized, array and control-character client correlation", () => {
        const f = fixture(false, {"x-soundspan-playback-run": "x".repeat(65), "x-soundspan-play-attempt": ["trace", "secret"]});
        f.response.emit("finish");
        expect(f.logs[0].playbackRunId).toBeUndefined();
        expect(f.logs[0].clientAttemptId).toBeUndefined();
        const control = fixture(false, {"x-soundspan-play-attempt": "trace\r\nsecret"});
        control.response.emit("finish");
        expect(control.logs[0].clientAttemptId).toBeUndefined();
        expect(JSON.stringify([...f.logs, ...control.logs])).not.toContain("secret");
    });

    it("retains late write failure as unknown after the client has closed", async () => {
        const f = fixture();
        let fail!: (error: Error) => void;
        const write = f.trace.write(() => new Promise((_, reject) => {fail = reject;}));
        f.response.emit("close");
        fail(new Error("fixture failure"));
        await expect(write).rejects.toThrow("fixture failure");
        expect(f.records.at(-1)).toMatchObject({stage: "db_acquire_write", outcome: "late_error", writeState: "unknown"});
        expect(f.records.filter((row) => row.stage === "request")).toHaveLength(1);
    });

    it.each([
        "validation",
        "context",
        "track_lookup",
        "metadata",
        "identity",
        "attribution",
    ] as const)(
        "attributes an isolated %s delay to that stage",
        async (stage) => {
            const f = fixture();
            await f.trace.measure(stage, () => {
                f.advance(123);
                return "value";
            });
            expect(f.records).toEqual([
                expect.objectContaining({
                    stage,
                    durationMs: 123,
                    outcome: "success",
                }),
            ]);
        },
    );

    it("survives broken instrumentation sinks without affecting a committed write", async () => {
        const res = Object.assign(new EventEmitter(), {
            locals: {},
            statusCode: 200,
            writableFinished: true,
            setHeader: jest.fn(),
        }) as unknown as Response;
        const trace = createPlayRequestTrace(
            {
                method: "POST",
                originalUrl: "/api/plays",
                headers: {
                    "x-soundspan-playback-run": "x".repeat(1000),
                    "x-soundspan-play-attempt": "bad\r\nheader",
                },
            } as unknown as Request,
            res,
            {
                record: () => {
                    throw new Error("metric sink");
                },
                log: () => {
                    throw new Error("log sink");
                },
            },
        )!;
        await expect(trace.write(async () => "saved")).resolves.toBe("saved");
        expect(() => res.emit("finish")).not.toThrow();
    });
});
