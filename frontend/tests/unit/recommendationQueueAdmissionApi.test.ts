import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { api } from "../../lib/api";
import { ApiClientCore, type ApiRequestOptions } from "../../lib/api/core";
import { WithRecommendations } from "../../lib/api/recommendations";
import type { FiniteQueueAdmissionReference } from "../../lib/audio/recommendationQueueAdmission";

const references = [
    { source: "library", id: "local-1", generationId: "generation-1" },
    { source: "youtube", id: "AAAAAAAAAAA" },
    { source: "library", id: "local-1", generationId: "generation-2" },
] as const;
const response = {
    version: 1,
    appliesTo: "recommended_future",
    decisions: [
        { source: "library", id: "local-1", state: "allowed" },
        { source: "youtube", id: "AAAAAAAAAAA", state: "denied" },
        { source: "library", id: "local-1", state: "unavailable" },
    ],
};

test("finite admission posts every ordered occurrence through the API boundary with a bounded cancelable budget", async () => {
    const request = mock.method(api, "request", async () => response);
    const controller = new AbortController();
    try {
        assert.deepEqual(
            await api.readmitRecommendationQueue(references, controller.signal),
            { status: "ready", response },
        );
        const [path, options] = request.mock.calls[0].arguments;
        assert.equal(path, "/personalized/queue-admission");
        assert.equal(options?.method, "POST");
        assert.deepEqual(JSON.parse(String(options?.body)), { references });
        assert.equal(options?.timeoutMs, 17_000);
        assert.equal(options?.retryOnTimeout, false);
        assert.equal(options?.silent404, true);
        assert.ok(options?.signal instanceof AbortSignal);
    } finally {
        request.mock.restore();
    }
});

test("finite admission strips unknown metadata rather than granting it authority", async () => {
    const request = mock.method(api, "request", async () => ({
        ...response,
        artistBans: ["invented"],
        decisions: response.decisions.map((row) => ({
            ...row,
            canonicalId: "untrusted",
        })),
    }));
    try {
        assert.deepEqual(await api.readmitRecommendationQueue(references), {
            status: "ready",
            response,
        });
    } finally {
        request.mock.restore();
    }
});

test("unknown policy, invalid state, wrong identity/order and incomplete/extra decisions are transient unavailable", async () => {
    const invalid = [
        null,
        { ...response, version: 2 },
        { ...response, appliesTo: "all_tracks" },
        { ...response, decisions: response.decisions.slice(0, 2) },
        {
            ...response,
            decisions: [...response.decisions, response.decisions[0]],
        },
        {
            ...response,
            decisions: [...response.decisions]
                .reverse()
                .map((row, i) => (i === 0 ? { ...row, id: "other" } : row)),
        },
        {
            ...response,
            decisions: [
                response.decisions[1],
                response.decisions[0],
                response.decisions[2],
            ],
        },
        {
            ...response,
            decisions: response.decisions.map((row) => ({
                ...row,
                state: "verified",
            })),
        },
    ];
    for (const value of invalid) {
        const request = mock.method(api, "request", async () => value);
        try {
            assert.deepEqual(await api.readmitRecommendationQueue(references), {
                status: "unavailable",
            });
        } finally {
            request.mock.restore();
        }
    }
});

test("invalid and over-limit references never issue a truncated request", async () => {
    const request = mock.method(api, "request", async () => response);
    try {
        for (const refs of [
            [],
            Array.from({ length: 101 }, () => ({
                source: "library",
                id: "local-1",
            })),
            [{ source: "youtube", id: "bad" }],
            [{ source: "library", id: "a:b" }],
            [{ source: "tidal", id: "9007199254740992" }],
            [{ source: "yandex", id: "0" }],
            [{ source: "vk", id: "bad" }],
            [{ source: "library", id: "local-1", generationId: "" }],
        ]) {
            assert.deepEqual(
                await api.readmitRecommendationQueue(
                    refs as FiniteQueueAdmissionReference[],
                ),
                { status: "unavailable" },
            );
        }
        assert.equal(request.mock.callCount(), 0);
    } finally {
        request.mock.restore();
    }
});

test("100 references and native recording identities survive without metadata", async () => {
    const refs: FiniteQueueAdmissionReference[] = Array.from(
        { length: 100 },
        (_, i) => ({ source: "tidal", id: String(i + 1) }),
    );
    refs.splice(
        0,
        4,
        { source: "vk", id: "-100_200" },
        { source: "yandex", id: "00042" },
        { source: "library", id: "local-1" },
        { source: "youtube", id: "AAAAAAAAAAA" },
    );
    const request = mock.method(api, "request", async () => ({
        version: 1,
        appliesTo: "recommended_future",
        decisions: refs.map((ref) => ({ ...ref, state: "allowed" })),
    }));
    try {
        assert.equal(
            (await api.readmitRecommendationQueue(refs)).status,
            "ready",
        );
        assert.equal(
            JSON.parse(String(request.mock.calls[0].arguments[1]?.body))
                .references.length,
            100,
        );
    } finally {
        request.mock.restore();
    }
});

test("only a missing legacy endpoint returns exact compatibility; other failures never become allowed", async () => {
    for (const [status, expected] of [
        [404, "legacy_exact"],
        [401, "unavailable"],
        [408, "unavailable"],
        [504, "unavailable"],
        [500, "unavailable"],
    ] as const) {
        const request = mock.method(api, "request", async () => {
            throw Object.assign(new Error("failure"), { status });
        });
        try {
            assert.deepEqual(await api.readmitRecommendationQueue(references), {
                status: expected,
            });
        } finally {
            request.mock.restore();
        }
    }
});

test("caller cancellation settles even when the underlying request ignores abort", async () => {
    let wireSignal: AbortSignal | undefined;
    const request = mock.method(
        api,
        "request",
        async (_path: string, options?: ApiRequestOptions) => {
            wireSignal = options?.signal ?? undefined;
            return new Promise(() => {});
        },
    );
    const controller = new AbortController();
    try {
        const pending = api.readmitRecommendationQueue(
            references,
            controller.signal,
        );
        controller.abort();
        assert.deepEqual(await pending, { status: "unavailable" });
        assert.equal(wireSignal?.aborted, true);
    } finally {
        request.mock.restore();
    }
});

test("overall transport deadline settles an auth or body stall without timeout retries", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let wireSignal: AbortSignal | undefined;
    const request = mock.method(
        api,
        "request",
        async (_path: string, options?: ApiRequestOptions) => {
            wireSignal = options?.signal ?? undefined;
            return new Promise(() => {});
        },
    );
    try {
        const pending = api.readmitRecommendationQueue(references);
        context.mock.timers.tick(17_000);
        assert.deepEqual(await pending, { status: "unavailable" });
        assert.equal(wireSignal?.aborted, true);
        assert.equal(request.mock.callCount(), 1);
    } finally {
        request.mock.restore();
    }
});

class Client extends WithRecommendations(ApiClientCore) {
    authenticateForTest(token: string): void {
        this.token = token;
    }
}

test("real API core retains credentials and rejects an old auth generation", async () => {
    const client = new Client("https://fixture.test");
    client.authenticateForTest("owner-token");
    let release!: (value: Response) => void;
    let auth: string | null = null;
    let credentials: RequestCredentials | undefined;
    const wire = mock.method(
        globalThis,
        "fetch",
        async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
            auth = new Headers(options?.headers).get("Authorization");
            credentials = options?.credentials;
            return new Promise<Response>((resolve) => {
                release = resolve;
            });
        },
    );
    try {
        const pending = client.readmitRecommendationQueue(references);
        client.clearToken();
        release(Response.json(response));
        assert.deepEqual(await pending, { status: "unavailable" });
        assert.equal(auth, "Bearer owner-token");
        assert.equal(credentials, "include");
        assert.equal(wire.mock.callCount(), 1);
    } finally {
        wire.mock.restore();
    }
});

test("a canceled admission cannot replay its wire request after a late successful auth refresh", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    class RefreshClient extends Client {
        override getRefreshToken(): string {
            return "refresh-token";
        }
    }
    const client = new RefreshClient("https://fixture.test");
    client.authenticateForTest("old-token");
    let refresh!: (value: Response) => void;
    let started!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    let admissionCalls = 0;
    const wire = mock.method(
        globalThis,
        "fetch",
        async (url: Parameters<typeof fetch>[0]) => {
            if (String(url).endsWith("/auth/refresh")) {
                started();
                return new Promise<Response>((resolve) => {
                    refresh = resolve;
                });
            }
            admissionCalls++;
            return admissionCalls === 1
                ? Response.json(
                      { code: "AUTH_REQUIRED", error: "Login required" },
                      { status: 401 },
                  )
                : Response.json(response);
        },
    );
    try {
        const pending = client.readmitRecommendationQueue(references);
        await refreshStarted;
        context.mock.timers.tick(17_000);
        assert.deepEqual(await pending, { status: "unavailable" });
        refresh(
            Response.json({
                token: "new-token",
                refreshToken: "rotated-token",
            }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(admissionCalls, 1);
    } finally {
        wire.mock.restore();
    }
});
