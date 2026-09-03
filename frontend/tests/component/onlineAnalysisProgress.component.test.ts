import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OnlineAnalysisProgress } from "../../features/settings/components/sections/OnlineAnalysisProgress";

const snapshot = {
    generatedAt: "2026-09-03T22:00:00.000Z",
    enabled: true,
    total: 100,
    activeSpace: { id: "active", family: "dclap" },
    activeAssets: 0,
    audio: { completed: 30, remaining: 70, failed: 2, completedLast24h: 5 },
    embeddings: {
        completed: 40,
        remaining: 60,
        failed: 3,
        completedLast24h: 7,
    },
    budget: {
        dailyLimit: 250,
        checkedToday: 258,
        concurrency: 2,
        resetsAt: "2026-09-04T00:00:00.000Z",
    },
};

function render(data?: typeof snapshot | null) {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    if (data) client.setQueryData(["online-analysis-progress"], data);
    return renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(OnlineAnalysisProgress),
        ),
    );
}

test("shows both real counters and distinguishes missing analysis from queued work", () => {
    const html = render(snapshot);
    assert.match(html, /30 из 100/);
    assert.match(html, /40 из 100/);
    assert.match(html, /30%/);
    assert.match(html, /40%/);
    assert.match(html, /Квота на сегодня исчерпана/);
    assert.match(html, /Без готового результата: 70/);
    assert.doesNotMatch(html, /В очереди: 70|258 из 250|100%/);
});

test("initial loading is not presented as zero analyzed", () => {
    const html = render();
    assert.match(html, /Загружаем счётчики/);
    assert.doesNotMatch(html, /0 из 0|Квота на сегодня исчерпана/);
});

test("empty canonical catalog has no fake 100 percent completion", () => {
    const empty = {
        completed: 0,
        remaining: 0,
        failed: 0,
        completedLast24h: 0,
    };
    const html = render({
        ...snapshot,
        total: 0,
        audio: empty,
        embeddings: empty,
    });
    assert.match(html, /В общем каталоге пока нет записей/);
    assert.doesNotMatch(html, /100%|0 из 0/);
});

test("failed refresh keeps real counts with a stale warning", async () => {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["online-analysis-progress"], snapshot);
    await client
        .fetchQuery({
            queryKey: ["online-analysis-progress"],
            queryFn: async () => {
                throw new Error("offline");
            },
        })
        .catch(() => undefined);
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(OnlineAnalysisProgress),
        ),
    );
    assert.match(html, /Показаны последние полученные данные/);
    assert.match(html, /30 из 100/);
    assert.match(html, /Повторить/);
});

test("first request failure displays unavailable rather than zero", async () => {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    await client
        .fetchQuery({
            queryKey: ["online-analysis-progress"],
            queryFn: async () => {
                throw new Error("offline");
            },
        })
        .catch(() => undefined);
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(OnlineAnalysisProgress),
        ),
    );
    assert.match(html, /Не удалось загрузить счётчики анализа/);
    assert.doesNotMatch(html, /0 из 0|Квота на сегодня исчерпана/);
});
