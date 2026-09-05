import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";

import { SettingsSaveDock } from "../../features/settings/components/SettingsSaveDock";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    GlobalRegistrator.unregister();
});

test("settings save status and action stay above player chrome without overlapping", async () => {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let saveCalls = 0;

    await React.act(async () => {
        root.render(
            React.createElement(SettingsSaveDock, {
                isSaving: false,
                status: "error",
                message: "Не удалось сохранить настройки профиля",
                onSave: () => {
                    saveCalls += 1;
                },
            }),
        );
    });

    const dock = container.querySelector<HTMLElement>(
        '[data-testid="settings-save-dock"]',
    );
    const panel = container.querySelector<HTMLElement>(
        '[data-testid="settings-save-panel"]',
    );
    const status = container.querySelector<HTMLElement>(
        '[data-testid="settings-save-status"]',
    );
    const save = container.querySelector<HTMLButtonElement>("button");

    assert.ok(dock);
    assert.ok(panel);
    assert.ok(status);
    assert.ok(save);
    assert.match(dock.className, /app-mini-player-height/);
    assert.match(dock.className, /app-bottom-nav-height/);
    assert.match(
        dock.className,
        /md:bottom-\[calc\(var\(--app-player-height-desktop\)/,
    );
    assert.match(panel.className, /grid-cols-1/);
    assert.match(panel.className, /min-\[420px\]:grid-cols-/);
    assert.match(status.className, /min-w-0/);
    assert.match(save.className, /w-full/);
    assert.match(save.className, /whitespace-nowrap/);

    await React.act(async () => save.click());
    assert.equal(saveCalls, 1);

    await React.act(async () => root.unmount());
    container.remove();
});
