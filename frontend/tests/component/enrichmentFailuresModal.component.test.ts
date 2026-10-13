import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let retryFails = false;
const retryFailedAudioAnalysis = mock.fn(async () => {
    if (retryFails) throw new Error("fixture retry unavailable");
    return { message: "reset", reset: 7226 };
});
const retryVibeEmbeddings = mock.fn(async () => ({
    message: "reset",
    reset: 1204,
}));
const reconcileFailures = mock.fn(async () => ({ resolved: 0, checked: 0 }));
let failureRows: Array<Record<string, unknown>> = [];

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        }),
    },
});

mock.module("@/lib/enrichmentApi", {
    namedExports: {
        enrichmentApi: {
            getFailures: async () => ({
                failures: failureRows,
                total: failureRows.length,
            }),
            getFailureCounts: async () => ({
                artist: 0,
                track: 0,
                audio: 7226,
                vibe: 1204,
                total: 8430,
            }),
            retryFailures: async () => ({ message: "", queued: 0 }),
            skipFailures: async () => ({ message: "", count: 0 }),
            deleteFailure: async () => ({ message: "", count: 0 }),
            clearAllFailures: async () => ({ message: "", count: 0 }),
            retryFailedAudioAnalysis,
            retryVibeEmbeddings,
            reconcileFailures,
        },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    retryFailedAudioAnalysis.mock.resetCalls();
    retryVibeEmbeddings.mock.resetCalls();
    reconcileFailures.mock.resetCalls();
    failureRows = [];
    retryFails = false;
    document.body.replaceChildren();
});

async function mountModal() {
    const { EnrichmentFailuresModal } =
        await import("../../components/EnrichmentFailuresModal");
    const { createRoot } = await import("react-dom/client");
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["enrichment-failure-counts"], {
        artist: 0,
        track: 0,
        audio: 7226,
        vibe: 1204,
        total: 8430,
    });
    queryClient.setQueryData(["enrichment-failures", "all", 1], {
        failures: failureRows,
        total: failureRows.length,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(EnrichmentFailuresModal, {
                    isOpen: true,
                    onClose: () => undefined,
                }),
            ),
        );
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    return {
        container,
        unmount: async () => React.act(async () => root.unmount()),
    };
}

function buttonWithText(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
            candidate.textContent?.replace(/\s+/g, " ").trim() === text,
    );
    const labels = Array.from(document.querySelectorAll("button")).map(
        (candidate) => candidate.textContent?.replace(/\s+/g, " ").trim(),
    );
    assert.ok(
        button instanceof HTMLButtonElement,
        `Missing ${text} button; found ${labels.join(", ")}`,
    );
    return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
}

test("retries every audio failure instead of only the visible page", async (t) => {
    const harness = await mountModal();
    t.after(harness.unmount);
    assert.equal(reconcileFailures.mock.callCount(), 1);
    await click(buttonWithText("Анализ аудио (7226)"));
    await click(buttonWithText("Повторить все (7226)"));
    assert.match(document.body.textContent ?? "", /Фоновая очередь/);
    await click(buttonWithText("Повторить всё"));
    assert.equal(retryFailedAudioAnalysis.mock.callCount(), 1);

    await click(buttonWithText("Векторы Vibe (1204)"));
    await click(buttonWithText("Повторить все (1204)"));
    await click(buttonWithText("Повторить всё"));
    assert.equal(retryVibeEmbeddings.mock.callCount(), 1);
    assert.equal(reconcileFailures.mock.callCount(), 3);
});

test("renders sanitized summaries and accurate missing-detail fallbacks", async (t) => {
    failureRows = [
        {
            id: "summary",
            entityType: "audio",
            entityId: "track-summary",
            entityName: "Summary Track",
            errorSummary: "Decoder rejected the stream",
            errorCode: "AUDIO_DECODE_FAILED",
            retryCount: 1,
            maxRetries: 3,
            lastFailedAt: "2026-08-20T12:00:00.000Z",
        },
        {
            id: "code",
            entityType: "vibe",
            entityId: "track-code",
            entityName: "Code Track",
            errorSummary: null,
            errorCode: "VIBE_EMBEDDING_FAILED",
            retryCount: 1,
            maxRetries: 3,
            lastFailedAt: "2026-08-20T12:00:00.000Z",
        },
        {
            id: "empty",
            entityType: "track",
            entityId: "track-empty",
            entityName: "Empty Track",
            errorSummary: null,
            errorCode: null,
            retryCount: 1,
            maxRetries: 3,
            lastFailedAt: "2026-08-20T12:00:00.000Z",
        },
    ];

    const harness = await mountModal();
    t.after(harness.unmount);

    assert.match(
        document.body.textContent ?? "",
        /Decoder rejected the stream/,
    );
    assert.match(document.body.textContent ?? "", /VIBE_EMBEDDING_FAILED/);
    assert.match(
        document.body.textContent ?? "",
        /Подробности ошибки не сохранены/,
    );
    assert.doesNotMatch(document.body.textContent ?? "", /Unknown error/);
});

async function mountInteractiveModal() {
    const { EnrichmentFailuresModal } =
        await import("../../components/EnrichmentFailuresModal");
    const { createRoot } = await import("react-dom/client");
    const client = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    client.setQueryData(["enrichment-failure-counts"], {
        artist: 0,
        track: 0,
        audio: 7226,
        vibe: 1204,
        total: 8430,
    });
    const container = document.createElement("div");
    container.style.overflow = "hidden";
    document.body.appendChild(container);
    function Interactive() {
        const [open, setOpen] = React.useState(false);
        return React.createElement(
            React.Fragment,
            null,
            React.createElement(
                "button",
                { onClick: () => setOpen(true) },
                "Открыть ошибки",
            ),
            React.createElement(EnrichmentFailuresModal, {
                isOpen: open,
                onClose: () => setOpen(false),
            }),
        );
    }
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Interactive),
            ),
        );
    });
    const opener = buttonWithText("Открыть ошибки");
    opener.focus();
    await click(opener);
    return {
        container,
        opener,
        unmount: async () => React.act(async () => root.unmount()),
    };
}
async function escape() {
    await React.act(async () => {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        await Promise.resolve();
    });
}
test("failure dialog escapes clipped content and Escape restores the opener", async (t) => {
    const h = await mountInteractiveModal();
    t.after(h.unmount);
    const panel = document.querySelector('[role="dialog"]');
    assert.ok(
        panel instanceof HTMLElement,
        "failure list has dialog semantics",
    );
    assert.equal(
        h.container.contains(panel),
        false,
        "failure list is outside clipped content",
    );
    assert.equal(panel.getAttribute("aria-modal"), "true");
    await escape();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.ok(
        document.activeElement === h.opener,
        "Escape restores the failure-list opener",
    );
});
test("Escape dismisses only the retry confirmation and retry errors stay visible", async (t) => {
    const h = await mountInteractiveModal();
    t.after(h.unmount);
    await click(buttonWithText("Анализ аудио (7226)"));
    const retryOpener = buttonWithText("Повторить все (7226)");
    retryOpener.focus();
    await click(retryOpener);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 2);
    await escape();
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(
        document.activeElement === retryOpener,
        "nested cancellation restores retry action",
    );
    assert.equal(retryFailedAudioAnalysis.mock.callCount(), 0);
    retryFails = true;
    await click(retryOpener);
    await click(buttonWithText("Повторить всё"));
    assert.equal(retryFailedAudioAnalysis.mock.callCount(), 1);
    assert.match(
        document.querySelector('[role="alert"]')?.textContent ?? "",
        /Не удалось запустить повтор/,
    );
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
});
