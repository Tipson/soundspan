import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

type HistorySummary = {
    allTime: number;
    last7Days: number;
    last30Days: number;
    last365Days: number;
};
let summary: HistorySummary;
let clearOperation: (range: string) => Promise<{ deletedCount: number }>;
const getPlayHistorySummary = mock.fn(async () => summary);
const clearPlayHistory = mock.fn(async (range: string) =>
    clearOperation(range),
);
beforeEach(() => {
    summary = { allTime: 12, last7Days: 3, last30Days: 7, last365Days: 10 };
    clearOperation = async () => ({ deletedCount: 0 });
    getPlayHistorySummary.mock.resetCalls();
    clearPlayHistory.mock.resetCalls();
    document.body.replaceChildren();
});

const Icon = () => React.createElement("i");

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    }) => React.createElement("a", { href, ...rest }, children),
});

mock.module("lucide-react", {
    namedExports: {
        AlertTriangle: Icon,
        ChevronDown: Icon,
        Check: Icon,
        X: Icon,
        Loader2: Icon,
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getPlayHistorySummary,
            clearPlayHistory,
        },
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

test("renders history settings row with my-history route", async () => {
    const { PlaybackHistorySection } =
        await import("../../features/settings/components/sections/PlaybackHistorySection");

    const html = renderToStaticMarkup(
        React.createElement(PlaybackHistorySection),
    );

    assert.match(html, /История и персонализация/);
    assert.match(html, /Открыть мою историю/);
    assert.match(html, /href="\/my-history"/);
    assert.match(html, /Очистить историю/);
});

test("renders configured history range options", async () => {
    const { PlaybackHistorySection } =
        await import("../../features/settings/components/sections/PlaybackHistorySection");

    const html = renderToStaticMarkup(
        React.createElement(PlaybackHistorySection),
    );

    assert.match(html, />За неделю</);
    assert.match(html, />За месяц</);
    assert.match(html, />За год</);
    assert.match(html, />За всё время</);
    assert.match(html, /Считаем события/);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function settle() {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("history clear requires confirmation, blocks pending duplicates and recovers from a sanitized failure", async (t) => {
    const { PlaybackHistorySection } =
        await import("../../features/settings/components/sections/PlaybackHistorySection");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });
    await React.act(async () => {
        root.render(React.createElement(PlaybackHistorySection));
        await settle();
    });
    const confirm = container.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
    );
    const range = container.querySelector<HTMLSelectElement>("select");
    const clear = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Очистить историю");
    assert.ok(confirm);
    assert.ok(range);
    assert.ok(clear);
    assert.equal(range.value, "30d");
    assert.match(container.textContent ?? "", /Будет удалено примерно: 7/);
    assert.equal(
        clear.disabled,
        true,
        "clear action requires explicit confirmation",
    );
    await React.act(async () => clear.click());
    assert.equal(clearPlayHistory.mock.callCount(), 0);

    const pending = deferred<{ deletedCount: number }>();
    clearOperation = () => pending.promise;
    await React.act(async () => confirm.click());
    assert.equal(clear.disabled, false);
    await React.act(async () => clear.click());
    assert.equal(clearPlayHistory.mock.callCount(), 1);
    assert.deepEqual(clearPlayHistory.mock.calls[0].arguments, ["30d"]);
    assert.equal(clear.disabled, true);
    assert.equal(range.disabled, true);
    assert.equal(confirm.disabled, true);
    assert.match(
        container.querySelector('[aria-live="polite"]')?.textContent ?? "",
        /Очищаем историю прослушиваний/,
    );
    await React.act(async () => clear.click());
    assert.equal(
        clearPlayHistory.mock.callCount(),
        1,
        "pending request cannot be sent twice",
    );

    const internalError =
        "ECONNRESET DELETE /api/plays/history private-db.internal";
    await React.act(async () => {
        pending.reject(new Error(internalError));
        await settle();
    });
    assert.match(
        container.querySelector('[aria-live="polite"]')?.textContent ?? "",
        /Не удалось очистить историю прослушиваний/,
    );
    assert.doesNotMatch(
        container.textContent ?? "",
        /ECONNRESET|private-db\.internal/,
    );
    assert.equal(clear.disabled, false, "failed clear can be retried");
    assert.equal(range.disabled, false);
    assert.equal(confirm.disabled, false);
    assert.equal(confirm.checked, true);
    assert.equal(
        getPlayHistorySummary.mock.callCount(),
        1,
        "failed deletion does not pretend to refresh counts",
    );

    await React.act(async () => {
        range.value = "7d";
        range.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(
        confirm.checked,
        false,
        "a different range requires a new confirmation",
    );
    assert.equal(clear.disabled, true);
    assert.equal(
        container.querySelector('[aria-live="polite"]'),
        null,
        "range change clears the previous error",
    );
    assert.match(container.textContent ?? "", /Будет удалено примерно: 3/);
    await React.act(async () => clear.click());
    assert.equal(clearPlayHistory.mock.callCount(), 1);

    summary = { allTime: 9, last7Days: 0, last30Days: 4, last365Days: 7 };
    clearOperation = async () => ({ deletedCount: 3 });
    await React.act(async () => confirm.click());
    await React.act(async () => {
        clear.click();
        await settle();
    });
    assert.equal(clearPlayHistory.mock.callCount(), 2);
    assert.deepEqual(clearPlayHistory.mock.calls[1].arguments, ["7d"]);
    assert.equal(
        getPlayHistorySummary.mock.callCount(),
        2,
        "successful retry loads refreshed summary",
    );
    assert.match(
        container.querySelector('[aria-live="polite"]')?.textContent ?? "",
        /Удалено событий: 3/,
    );
    assert.match(container.textContent ?? "", /Будет удалено примерно: 0/);
    assert.equal(confirm.checked, false);
    assert.equal(clear.disabled, true);
    assert.equal(range.disabled, false);
});
