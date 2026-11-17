import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import type { AdminRecommendationTraceResponse } from "../../lib/api/recommendationTrace";
import { advanceAuthRuntimeGeneration } from "../../lib/auth-runtime-generation";

GlobalRegistrator.register({ url: "https://soundspan.test/admin" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
    writable: true,
});
after(() => {
    GlobalRegistrator.unregister();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

let auth = {
    user: { id: "admin-1", role: "admin" },
    isAuthenticated: true,
    isLoading: false,
};
let session = 1;
let load: (
    userId: string,
    generationId: string,
    signal?: AbortSignal,
) => Promise<AdminRecommendationTraceResponse>;
const calls: { userId: string; generationId: string; signal?: AbortSignal }[] =
    [];
mock.module("@/lib/auth-context", { namedExports: { useAuth: () => auth } });
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getSessionGeneration: () => session,
            getAdminRecommendationTrace: (
                userId: string,
                generationId: string,
                signal?: AbortSignal,
            ) => {
                calls.push({ userId, generationId, signal });
                return load(userId, generationId, signal);
            },
        },
    },
});

function response(): Extract<
    AdminRecommendationTraceResponse,
    { available: true }
> {
    return {
        available: true,
        generationId: "generation-1",
        createdAt: "2026-11-17T12:00:00.000Z",
        surface: "wave",
        algorithm: "hybrid-v2",
        served: false,
        trace: {
            version: 1,
            policyVersion: "rank-trace-v1",
            algorithm: "hybrid-v2",
            mode: "shadow",
            served: false,
            assignment: null,
            requestedCount: 1,
            returnedCount: 1,
            shortfallCount: 0,
            coverage: {
                loadedCount: 4,
                sanitizedCount: 4,
                canonicalIdPresentCount: 1,
                embeddingPresentCount: 1,
                admittedCount: 2,
                rankInputCount: 2,
                loadedSources: {
                    youtube: 4,
                    library: 0,
                    tidal: 0,
                    vk: 0,
                    yandex: 0,
                },
            },
            filters: {
                invalidNative: 1,
                contentExcluded: 0,
                moodExcluded: 0,
                disliked: 1,
                feedbackUnavailable: 0,
            },
            ranker: {
                version: 1,
                policy: "hybrid-v2",
                inputCount: 2,
                counters: { input: 2, freshSelected: 1, duplicateCanonical: 1 },
            },
            spacing: {
                applied: false,
                scope: "page",
                observedRows: 1,
                movedOccurrences: 0,
                knownArtists: 1,
                unknownArtistRows: 0,
                adjacentKnownArtistPairs: 0,
                minimumKnownArtistGap: null,
            },
            items: [
                {
                    position: 0,
                    rankPosition: 2,
                    source: "youtube",
                    score: 0,
                    scoring: {
                        version: 1,
                        policy: "hybrid-v2",
                        baseScore: 0,
                        parts: [
                            { name: "providerPrior", state: "known", value: 0 },
                            {
                                name: "accountAffinity",
                                state: "absent",
                                value: null,
                            },
                            {
                                name: "exploration",
                                state: "unused",
                                value: null,
                            },
                        ],
                        selection: {
                            method: "mmr",
                            score: -0.1,
                            diversityPenalty: 0.1,
                            cooldown: "fresh",
                        },
                    },
                },
            ],
            truncated: false,
        },
        exposures: [
            {
                position: 0,
                source: "youtube",
                providerTrackId: "video-1",
                score: 0,
            },
        ],
    };
}

beforeEach(() => {
    auth = {
        user: { id: "admin-1", role: "admin" },
        isAuthenticated: true,
        isLoading: false,
    };
    session = 1;
    calls.length = 0;
    load = async () => response();
    advanceAuthRuntimeGeneration();
});

async function mount() {
    const { createRoot } = await import("react-dom/client");
    const { RecommendationTraceSection } =
        await import("../../features/settings/components/sections/RecommendationTraceSection");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async () => {
        await React.act(async () =>
            root.render(React.createElement(RecommendationTraceSection)),
        );
    };
    await render();
    return {
        container,
        render,
        dispose: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function input(container: HTMLElement, id: string) {
    const element = container.querySelector(`#${id}`);
    assert.ok(element instanceof HTMLInputElement);
    return element;
}
async function type(container: HTMLElement, id: string, value: string) {
    await React.act(async () => {
        const element = input(container, id);
        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
        )?.set;
        assert.ok(setter);
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
    });
}
async function fill(container: HTMLElement, owner = "owner-1") {
    await type(container, "recommendation-trace-user", owner);
    await type(container, "recommendation-trace-generation", "generation-1");
}
async function submit(container: HTMLElement) {
    await React.act(async () =>
        container
            .querySelector("form")!
            .dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true }),
            ),
    );
}

test("admin trace is explicit, labelled and absent for non-admin or loading auth", async () => {
    auth.user.role = "user";
    const panel = await mount();
    try {
        assert.equal(panel.container.querySelector("section"), null);
        auth.user.role = "admin";
        auth.isLoading = true;
        await panel.render();
        assert.equal(panel.container.querySelector("section"), null);
        auth.isLoading = false;
        await panel.render();
        assert.equal(calls.length, 0);
        assert.match(panel.container.textContent ?? "", /ID пользователя/);
        const button = panel.container.querySelector("button")!;
        assert.equal(button.disabled, true);
        assert.match(button.className, /min-h-11/);
        for (const id of [
            "recommendation-trace-user",
            "recommendation-trace-generation",
        ]) {
            const pattern = new RegExp(input(panel.container, id).pattern, "v");
            assert.equal(pattern.test("owner-1"), true);
            assert.equal(pattern.test("owner/other"), false);
        }
        await fill(panel.container);
        assert.equal(calls.length, 0);
        assert.equal(button.disabled, false);
        await type(panel.container, "recommendation-trace-user", "other/owner");
        assert.equal(button.disabled, true);
        assert.equal(calls.length, 0);
    } finally {
        await panel.dispose();
    }
});

test("diagnostics distinguish measured zero, unavailable parts and actual selection score", async () => {
    const panel = await mount();
    try {
        await fill(panel.container);
        await submit(panel.container);
        assert.deepEqual(
            calls.map(({ userId, generationId }) => [userId, generationId]),
            [["owner-1", "generation-1"]],
        );
        assert.equal(
            panel.container.querySelector(
                '[data-score-part="providerPrior"] dd',
            )?.textContent,
            "0",
        );
        assert.equal(
            panel.container.querySelector(
                '[data-score-part="accountAffinity"] dd',
            )?.textContent,
            "нет данных",
        );
        assert.equal(
            panel.container.querySelector('[data-score-part="exploration"] dd')
                ?.textContent,
            "не используется",
        );
        assert.match(
            panel.container.textContent ?? "",
            /Теневой расчёт.*не выдано/,
        );
        assert.match(panel.container.textContent ?? "", /MMR-оценка.*-0.1/);
        assert.match(panel.container.textContent ?? "", /прослушивание/);
        assert.match(panel.container.textContent ?? "", /Позиция 0/);
        assert.match(panel.container.textContent ?? "", /До расстановки.*2/);
        assert.match(panel.container.textContent ?? "", /Запрошено.*1/);
        assert.match(panel.container.textContent ?? "", /Недобор.*0/);
        assert.match(
            panel.container.textContent ?? "",
            /Каноническая identity.*1/,
        );
        assert.match(panel.container.textContent ?? "", /Векторы.*1/);
        assert.match(
            panel.container.textContent ?? "",
            /Счётчики ранжирования/,
        );
        assert.match(panel.container.textContent ?? "", /Повтор canonical.*1/);
    } finally {
        await panel.dispose();
    }
});

test("field changes abort and hide old-owner results even when late requests ignore cancellation", async () => {
    let finishOld: (value: AdminRecommendationTraceResponse) => void = () => {};
    load = () =>
        new Promise((resolve) => {
            finishOld = resolve;
        });
    const panel = await mount();
    try {
        await fill(panel.container);
        await submit(panel.container);
        await type(panel.container, "recommendation-trace-user", "owner-2");
        assert.equal(calls[0].signal?.aborted, true);
        await React.act(async () => finishOld(response()));
        assert.equal(
            panel.container.querySelector('[data-score-part="providerPrior"]'),
            null,
        );
        load = async () => response();
        await submit(panel.container);
        assert.equal(calls.at(-1)?.userId, "owner-2");
        assert.ok(
            panel.container.querySelector('[data-score-part="providerPrior"]'),
        );
    } finally {
        await panel.dispose();
    }
});

test("auth owner changes reset fields and reject pending results; unmount aborts the next request", async () => {
    let finish: (value: AdminRecommendationTraceResponse) => void = () => {};
    load = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    const panel = await mount();
    await fill(panel.container);
    await submit(panel.container);
    auth = { ...auth, user: { id: "admin-2", role: "admin" } };
    await panel.render();
    assert.equal(calls[0].signal?.aborted, true);
    assert.equal(input(panel.container, "recommendation-trace-user").value, "");
    await React.act(async () => finish(response()));
    assert.equal(
        panel.container.querySelector('[data-score-part="providerPrior"]'),
        null,
    );
    await fill(panel.container);
    await submit(panel.container);
    const last = calls.at(-1)!;
    await panel.dispose();
    assert.equal(last.signal?.aborted, true);
    await React.act(async () => finish(response()));
});

test("runtime revocation clears visible diagnostics and credential rotation fences a pending result", async () => {
    const panel = await mount();
    try {
        await fill(panel.container);
        await submit(panel.container);
        assert.ok(
            panel.container.querySelector('[data-score-part="providerPrior"]'),
        );
        await React.act(async () => {
            advanceAuthRuntimeGeneration();
        });
        assert.equal(
            panel.container.querySelector('[data-score-part="providerPrior"]'),
            null,
        );
        assert.equal(
            input(panel.container, "recommendation-trace-user").value,
            "",
        );
        let finish: (
            value: AdminRecommendationTraceResponse,
        ) => void = () => {};
        load = () =>
            new Promise((resolve) => {
                finish = resolve;
            });
        await fill(panel.container);
        await submit(panel.container);
        session++;
        await panel.render();
        await React.act(async () => finish(response()));
        assert.equal(
            panel.container.querySelector('[data-score-part="providerPrior"]'),
            null,
        );
        assert.equal(calls.at(-1)?.signal?.aborted, true);
    } finally {
        await panel.dispose();
    }
});

test("legacy and missing generations give friendly bounded errors without raw server details", async () => {
    const panel = await mount();
    try {
        load = async () => ({ available: false, generationId: "generation-1" });
        await fill(panel.container);
        await submit(panel.container);
        assert.match(
            panel.container.textContent ?? "",
            /диагностика недоступна/i,
        );
        load = async () => {
            throw Object.assign(new Error("raw-secret-token"), { status: 404 });
        };
        await submit(panel.container);
        assert.match(panel.container.textContent ?? "", /не найдена/i);
        assert.doesNotMatch(panel.container.textContent ?? "", /raw-secret/);
    } finally {
        await panel.dispose();
    }
});

test("details are capped and explicitly describe the captured scope", async () => {
    const value = response();
    value.trace.truncated = true;
    value.trace.returnedCount = 1000;
    value.trace.spacing.scope = "captured-prefix";
    value.trace.spacing.observedRows = 75;
    value.trace.items = Array.from({ length: 90 }, (_, position) => ({
        ...value.trace.items[0],
        position,
    }));
    load = async () => value;
    const panel = await mount();
    try {
        await fill(panel.container);
        await submit(panel.container);
        assert.equal(
            panel.container.querySelectorAll("[data-trace-occurrence]").length,
            75,
        );
        assert.match(panel.container.textContent ?? "", /фрагмент/i);
        assert.match(panel.container.textContent ?? "", /1000/);
    } finally {
        await panel.dispose();
    }
});
