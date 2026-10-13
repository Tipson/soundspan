import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { createRoot } from "react-dom/client";
import { SettingsRow } from "../../features/settings/components/ui/SettingsRow";
import { SettingsSelect } from "../../features/settings/components/ui/SettingsSelect";
import { SettingsInput } from "../../features/settings/components/ui/SettingsInput";
import { SettingsSaveDock } from "../../features/settings/components/SettingsSaveDock";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

test("settings select inherits its row label and changes the selected value", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const changes: string[] = [];
    await React.act(async () => {
        root.render(
            React.createElement(
                SettingsRow,
                { label: "Качество звука" } as React.ComponentProps<
                    typeof SettingsRow
                >,
                React.createElement(SettingsSelect, {
                    value: "high",
                    options: [
                        { value: "high", label: "Высокое" },
                        { value: "original", label: "Оригинальное" },
                    ],
                    onChange: (value) => changes.push(value),
                }),
            ),
        );
    });
    const select = container.querySelector<HTMLSelectElement>("select");
    assert.ok(select);
    const label = container.querySelector('[id$="-label"]');
    assert.equal(select.getAttribute("aria-labelledby"), label?.id);
    assert.ok(select.id, "Generated select must have an identifier");
    await React.act(async () => {
        select.value = "original";
        select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.deepEqual(changes, ["original"]);
    await React.act(async () => root.unmount());
});

test("disabled password field keeps its visibility action disabled", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(SettingsInput, {
                value: "provider-secret",
                type: "password",
                disabled: true,
                onChange: () => undefined,
            }),
        );
    });
    const button = container.querySelector<HTMLButtonElement>("button");
    assert.ok(button?.disabled);
    await React.act(async () => button.click());
    assert.equal(container.querySelector("input")?.type, "password");
    await React.act(async () => root.unmount());
});

test("dirty settings explain their state and saving prevents duplicate actions", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let calls = 0;
    const props = {
        hasChanges: true,
        onSave: () => {
            calls += 1;
        },
    };
    await React.act(async () => {
        root.render(
            React.createElement(SettingsSaveDock, {
                ...props,
                isSaving: false,
                status: "idle",
            }),
        );
    });
    assert.equal(
        container.querySelector('[role="status"]')?.textContent,
        "Изменения не сохранены",
    );
    await React.act(async () =>
        container.querySelector<HTMLButtonElement>("button")?.click(),
    );
    assert.equal(calls, 1);
    await React.act(async () => {
        root.render(
            React.createElement(SettingsSaveDock, {
                ...props,
                isSaving: true,
                status: "loading",
            }),
        );
    });
    const savingButton = container.querySelector<HTMLButtonElement>("button");
    assert.ok(savingButton?.disabled);
    assert.equal(savingButton.getAttribute("aria-busy"), "true");
    await React.act(async () => savingButton.click());
    assert.equal(calls, 1);
    await React.act(async () => root.unmount());
});
