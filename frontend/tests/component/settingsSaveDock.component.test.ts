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

test("pristine user settings have no save button and successful saves retain feedback", async () => {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container);
    const props = {
        isSaving: false,
        hasChanges: false,
        placement: "inline" as const,
        onSave: () => undefined,
    };
    await React.act(async () =>
        root.render(
            React.createElement(SettingsSaveDock, { ...props, status: "idle" }),
        ),
    );
    assert.ok(
        container.querySelector("button") === null,
        "Pristine settings must not render a save button",
    );
    await React.act(async () =>
        root.render(
            React.createElement(SettingsSaveDock, {
                ...props,
                status: "success",
                message: "Настройки сохранены",
            }),
        ),
    );
    assert.ok(
        container.querySelector("button") === null,
        "A saved result must not keep the save button visible",
    );
    assert.match(container.textContent ?? "", /Настройки сохранены/);
    await React.act(async () =>
        root.render(
            React.createElement(SettingsSaveDock, {
                ...props,
                hasChanges: true,
                status: "idle",
            }),
        ),
    );
    assert.ok(container.querySelector("button"));
    await React.act(async () => root.unmount());
});

test("settings save feedback shares a responsive panel and save action stays callable", async () => {
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
    assert.ok(panel.contains(status));
    assert.ok(panel.contains(save));
    assert.match(
        status.textContent ?? "",
        /Не удалось сохранить настройки профиля/,
    );
    assert.equal(save.textContent, "Сохранить");
    assert.equal(save.disabled, false);

    await React.act(async () => save.click());
    assert.equal(saveCalls, 1);
    await React.act(async () =>
        root.render(
            React.createElement(SettingsSaveDock, {
                isSaving: true,
                status: "idle",
                onSave: () => {
                    saveCalls += 1;
                },
            }),
        ),
    );
    const savingButton = container.querySelector<HTMLButtonElement>("button");
    assert.ok(savingButton?.disabled);
    assert.equal(savingButton.getAttribute("aria-busy"), "true");
    await React.act(async () => savingButton.click());
    assert.equal(saveCalls, 1, "Saving must prevent a repeat submission");

    await React.act(async () => root.unmount());
    container.remove();
});
