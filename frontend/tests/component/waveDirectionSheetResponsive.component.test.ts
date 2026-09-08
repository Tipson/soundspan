import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";

import { WaveDirectionSheet } from "../../components/vibe/WaveDirectionSheet";

GlobalRegistrator.register({ url: "https://soundspan.test/vibe" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    GlobalRegistrator.unregister();
});

test("Wave keeps long mood labels readable on one line without shortening accessible names", async () => {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let applied: unknown[] | null = null;

    await React.act(async () => {
        root.render(
            React.createElement(WaveDirectionSheet, {
                activeMode: "for-you",
                activeMood: null,
                activeLanguage: "ru",
                onApply: (...selection) => {
                    applied = selection;
                },
                onClose: () => undefined,
            }),
        );
    });

    const focus = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Для концентрации"]',
    );
    assert.ok(focus);
    assert.match(focus.textContent ?? "", /Фокус/);
    assert.doesNotMatch(focus.textContent ?? "", /Для концентрации/);
    const label = Array.from(focus.querySelectorAll("span")).find(
        (span) => span.textContent?.trim() === "Фокус",
    );
    assert.ok(label);
    assert.match(label.className, /whitespace-nowrap/);

    const workout = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Для тренировки"]',
    );
    assert.ok(workout);
    assert.match(workout.textContent ?? "", /Тренировка/);
    assert.doesNotMatch(workout.textContent ?? "", /Для тренировки/);
    const languageGroup = container.querySelector(
        '[role="radiogroup"][aria-label="Язык исполнения"]',
    );
    assert.equal(languageGroup, null);
    const apply = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Сохранить настройку:"]',
    );
    assert.ok(apply);
    await React.act(async () => apply.click());
    assert.deepEqual(applied, ["for-you", null, "any"]);
    assert.equal(
        container
            .querySelector('[role="radio"][aria-label="Для вас"]')
            ?.getAttribute("aria-checked"),
        "true",
    );

    await React.act(async () => root.unmount());
    container.remove();
});
