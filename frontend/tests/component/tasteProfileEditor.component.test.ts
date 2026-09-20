import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { TasteProfileEditor } from "../../features/taste-profile/components/TasteProfileEditor";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import type { TasteProfileState } from "../../features/taste-profile/types";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

function button(container: ParentNode, label: string) {
    const found = Array.from(container.querySelectorAll("button")).find(
        (item) =>
            item.getAttribute("aria-label") === label ||
            item.textContent?.trim() === label,
    );
    assert.ok(found, `expected button ${label}`);
    return found;
}
async function flush() {
    for (let i = 0; i < 5; i++)
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
}

test("editor shows load failures, retries, preserves a failed save and reopens persisted choices", async () => {
    const { createRoot } = await import("react-dom/client");
    const originalRequest = api.request;
    let rejectLoad!: (error: Error) => void;
    let failLoad = true;
    let failSave = true;
    let state: TasteProfileState = {
        profile: {
            genres: ["Рок", "Метал"],
            artists: ["Muse"],
            seedTracks: [],
        },
        completedAt: "2026-09-20T00:00:00Z",
        skippedAt: null,
        needsOnboarding: false,
    };
    api.request = (async (_path: string, options?: RequestInit) => {
        if (options?.method === "PUT") {
            if (failSave) throw new Error("offline");
            const selection = JSON.parse(String(options.body));
            state = {
                ...state,
                profile: { ...selection, seedTracks: [] },
                completedAt: "2026-09-20T00:01:00Z",
            };
            return state;
        }
        if (failLoad)
            return new Promise((_resolve, reject) => {
                rejectLoad = reject;
            });
        return state;
    }) as typeof api.request;
    const client = new QueryClient({
        defaultOptions: {
            queries: { retryDelay: 0 },
            mutations: { retry: false },
        },
    });
    const homeKey = queryKeys.personalizedHome(24);
    client.setQueryData(homeKey, { marker: "old tastes" });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let open = true;
    const render = () =>
        root.render(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(TasteProfileEditor, {
                    accountId: "listener",
                    isOpen: open,
                    onClose: () => {
                        open = false;
                        render();
                    },
                }),
            ),
        );
    try {
        await React.act(async () => render());
        assert.match(
            container.textContent ?? "",
            /Загружаем музыкальные вкусы/,
        );
        await React.act(async () => rejectLoad(new Error("offline")));
        await flush();
        await React.act(async () => rejectLoad(new Error("offline")));
        await flush();
        assert.match(
            container.querySelector('[role="alert"]')?.textContent ?? "",
            /Не удалось загрузить/,
        );
        failLoad = false;
        await React.act(async () =>
            button(container, "Повторить загрузку").click(),
        );
        await flush();
        await React.act(async () => button(container, "Джаз").click());
        await React.act(async () =>
            button(container, "Дальше: артисты").click(),
        );
        await React.act(async () =>
            button(container, "Дальше: проверить выбор").click(),
        );
        await React.act(async () =>
            button(container, "Сохранить вкусы").click(),
        );
        await flush();
        assert.equal(open, true);
        assert.match(
            container.querySelector('[role="alert"]')?.textContent ?? "",
            /Не удалось сохранить/,
        );
        assert.ok(button(container, "Убрать жанр: Джаз"));
        failSave = false;
        await React.act(async () =>
            button(container, "Сохранить вкусы").click(),
        );
        await flush();
        assert.equal(open, false);
        assert.equal(client.getQueryState(homeKey)?.isInvalidated, true);
        // Force the next open through GET, not merely the mutation's local cache.
        client.removeQueries({ queryKey: queryKeys.tasteProfile("listener") });
        open = true;
        await React.act(async () => render());
        await flush();
        assert.equal(
            button(container, "Джаз").getAttribute("aria-pressed"),
            "true",
        );
        assert.equal(
            button(container, "Рок").getAttribute("aria-pressed"),
            "true",
        );
        await React.act(async () =>
            button(container, "Закрыть настройку вкусов").click(),
        );
        assert.equal(open, false);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
        client.clear();
        api.request = originalRequest;
    }
});
