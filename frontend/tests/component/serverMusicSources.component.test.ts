import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const saves: unknown[] = [];
mock.module("../../lib/api", {
    namedExports: {
        api: {
            getMusicSourceConnections: async () => ({
                connections: [
                    {
                        provider: "yandex",
                        configured: true,
                        enabled: true,
                        version: 1,
                    },
                ],
                health: {
                    activeStreams: { "yandex:1": 2 },
                    circuits: [
                        {
                            connection: "yandex:1",
                            until: Date.now() + 60_000,
                            code: "rate_limit",
                        },
                    ],
                    usage: {
                        since: 1,
                        providers: {
                            yandex: {
                                resolutionAttempts: 5,
                                selected: 4,
                                noMatch: 1,
                                resolutionFailed: 0,
                                resolutionCancelled: 0,
                                streamRequests: 7,
                                streamCompleted: 5,
                                streamFailed: 1,
                                streamCancelled: 1,
                                lastFailure: "unavailable",
                            },
                        },
                    },
                },
            }),
            saveMusicSourceConnection: async (...args: unknown[]) => {
                saves.push(args);
            },
            searchMusicSource: async () => ({ tracks: [] }),
        },
    },
});
after(async () => {
    mock.restoreAll();
    await GlobalRegistrator.unregister();
});
test("admin sees server connection state and can disable it without resending credentials", async () => {
    const { ServerMusicSources } =
        await import("../../features/settings/components/sections/ServerMusicSources");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(React.createElement(ServerMusicSources));
    });
    assert.match(container.textContent ?? "", /Яндекс Музыка/);
    assert.match(container.textContent ?? "", /VK Музыка/);
    const fields = container.querySelectorAll<HTMLInputElement>(
        'input[type="password"]',
    );
    assert.equal(fields.length, 2);
    assert.equal(fields[0].value, "");
    assert.match(container.textContent ?? "", /Лимит запросов источника/);
    assert.match(container.textContent ?? "", /Статистика с запуска сервера/);
    assert.match(container.textContent ?? "", /Выбран для воспроизведения4/);
    assert.match(container.textContent ?? "", /Запросы аудио7/);
    const button = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Отключить",
    );
    assert.ok(button);
    await act(async () => {
        button.click();
    });
    assert.deepEqual(saves, [["yandex", { enabled: false }]]);
    await act(async () => root.unmount());
    container.remove();
});
