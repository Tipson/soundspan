import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

/** Closed stage vocabulary; DB pool wait is included in db_acquire_write. */
export type PlayRequestStage =
    | "auth"
    | "validation"
    | "context"
    | "track_lookup"
    | "metadata"
    | "identity"
    | "db_acquire_write"
    | "attribution"
    | "response_headers"
    | "request";
/** A resolved Prisma write acknowledges commit; a rejected call remains unknown. */
export type PlayWriteState =
    | "not_started"
    | "inflight"
    | "committed"
    | "unknown";
/** Anonymous sample accepted by the process-local HTTP instruments. */
export interface PlayStageSample {
    requestKind: "create" | "engagement";
    pathKind: "regular" | "diagnostic";
    stage: PlayRequestStage;
    outcome: "success" | "error" | "cancelled" | "late_success" | "late_error";
    writeState: PlayWriteState;
    activeStage: PlayRequestStage;
    durationMs: number;
}
/** Per-request observer with no retained global trace or ID collection. */
export interface PlayRequestTrace {
    measure<T>(stage: PlayRequestStage, work: () => Promise<T> | T): Promise<T>;
    write<T>(work: () => Promise<T>): Promise<T>;
    authenticated(): void;
    respond(): void;
}
/** Dependencies allow deterministic clocks and isolated metrics in fixtures. */
export interface PlayRequestTraceOptions {
    record(sample: PlayStageSample): void;
    log?(event: string, fields: Record<string, unknown>): void;
    now?: () => number;
}

const traceKey = Symbol("playRequestTrace");
function correlationId(value: unknown): string | undefined {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
        ? value
        : undefined;
}

/** Attach correlation and finite stage observations to the existing HTTP lifecycle. */
export function createPlayRequestTrace(
    req: Request,
    res: Response,
    options: PlayRequestTraceOptions,
): PlayRequestTrace | undefined {
    const path = (req.originalUrl || req.path).split("?")[0];
    const requestKind =
        req.method === "POST" && /^\/api\/plays\/?$/.test(path)
            ? "create"
            : req.method === "PATCH" &&
                /^\/api\/plays\/[^/]+\/engagement\/?$/.test(path)
              ? "engagement"
              : undefined;
    if (!requestKind) return undefined;
    const now = options.now ?? (() => performance.now());
    const started = now();
    const pathKind =
        req.headers["x-soundspan-diagnostic"] === "playback"
            ? "diagnostic"
            : "regular";
    const ids = {
        apiRequestId: randomUUID(),
        playbackRunId: correlationId(req.headers["x-soundspan-playback-run"]),
        clientAttemptId: correlationId(req.headers["x-soundspan-play-attempt"]),
    };
    let writeState: PlayWriteState = "not_started";
    let activeStage: PlayRequestStage = "auth";
    let terminal = false;
    let headersObserved = false;
    function emit(
        stage: PlayRequestStage,
        outcome: PlayStageSample["outcome"],
        since: number,
    ) {
        const sample: PlayStageSample = {
            requestKind: requestKind!,
            pathKind,
            stage,
            outcome,
            writeState,
            activeStage,
            durationMs: Math.max(0, now() - since),
        };
        // Instrumentation is observational: a failed sink cannot change a write.
        try {
            options.record(sample);
        } catch {
            /* retain request behavior */
        }
        try {
            options.log?.("playback.play.stage", { ...sample, ...ids });
        } catch {
            /* retain request behavior */
        }
    }
    const trace: PlayRequestTrace = {
        authenticated() {
            if (activeStage !== "auth") return;
            emit("auth", "success", started);
            activeStage = "validation";
        },
        async measure(stage, work) {
            activeStage = stage;
            const since = now();
            try {
                const value = await work();
                emit(stage, terminal ? "late_success" : "success", since);
                return value;
            } catch (error) {
                emit(stage, terminal ? "late_error" : "error", since);
                throw error;
            }
        },
        async write(work) {
            writeState = "inflight";
            return trace.measure("db_acquire_write", async () => {
                try {
                    const result = await work();
                    writeState = "committed";
                    return result;
                } catch (error) {
                    writeState = "unknown";
                    throw error;
                }
            });
        },
        respond() {
            if (terminal) return;
            res.setHeader("X-Soundspan-Play-Write", writeState);
        },
    };
    res.setHeader("X-Soundspan-Play-Trace", ids.apiRequestId);
    const originalWriteHead = res.writeHead;
    res.writeHead = function (this: Response, ...args: unknown[]) {
        if (!this.headersSent) {
            this.setHeader("X-Soundspan-Play-Write", writeState);
        }
        const result = Reflect.apply(originalWriteHead, this, args);
        if (!terminal && !headersObserved) {
            headersObserved = true;
            activeStage = "response_headers";
            emit("response_headers", "success", started);
        }
        return result;
    } as Response["writeHead"];
    (res.locals as Record<symbol, unknown>)[traceKey] = trace;
    const complete = (cancelled: boolean) => {
        if (terminal) return;
        terminal = true;
        emit(
            "request",
            cancelled
                ? "cancelled"
                : res.statusCode >= 400
                  ? "error"
                  : "success",
            started,
        );
    };
    res.once("finish", () => complete(false));
    res.once("close", () => complete(!res.writableFinished));
    return trace;
}

const unobservedTrace: PlayRequestTrace = {
    measure: async (_stage, work) => work(),
    write: async (work) => work(),
    authenticated: () => {},
    respond: () => {},
};

/** Read the middleware observer, preserving standalone router compatibility. */
export function playRequestTrace(res: Response): PlayRequestTrace {
    const trace =
        ((res.locals as Record<symbol, unknown>)?.[
            traceKey
        ] as PlayRequestTrace) ?? unobservedTrace;
    trace.authenticated();
    return trace;
}
