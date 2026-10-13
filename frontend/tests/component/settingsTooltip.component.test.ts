import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { createRoot } from "react-dom/client";
import { InfoTooltip } from "../../features/settings/components/ui/InfoTooltip";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

test("settings hint escapes a clipped card and closes with Escape", async () => {
    const container = document.createElement("div");
    container.style.overflow = "hidden";
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () =>
        root.render(
            React.createElement(InfoTooltip, {
                text: "Как работает выравнивание громкости",
            }),
        ),
    );
    const trigger = container.querySelector<HTMLButtonElement>("button");
    assert.ok(trigger);
    await React.act(async () => trigger.click());
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
    assert.ok(tooltip);
    assert.ok(
        !container.contains(tooltip),
        "Hint must escape ancestors with clipped overflow",
    );
    assert.equal(trigger.getAttribute("aria-describedby"), tooltip.id);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    await React.act(async () =>
        window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    assert.equal(document.querySelector('[role="tooltip"]'), null);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await React.act(async () => root.unmount());
    container.remove();
});

test("settings hint is available when its trigger receives keyboard focus", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () =>
        root.render(
            React.createElement(InfoTooltip, { text: "Подробности настройки" }),
        ),
    );
    const trigger = container.querySelector<HTMLButtonElement>("button");
    assert.ok(trigger);
    await React.act(async () => trigger.focus());
    assert.match(
        document.querySelector('[role="tooltip"]')?.textContent ?? "",
        /Подробности настройки/,
    );
    await React.act(async () => trigger.click());
    assert.ok(
        document.querySelector('[role="tooltip"]'),
        "Pointer click after focus must keep the hint available",
    );
    await React.act(async () => trigger.blur());
    assert.equal(document.querySelector('[role="tooltip"]'), null);
    await React.act(async () => root.unmount());
    container.remove();
});

test("pointer can cross the gap to the hint and read its scrollable content", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () =>
        root.render(
            React.createElement(InfoTooltip, {
                text: "Подробности ".repeat(60),
            }),
        ),
    );
    const trigger = container.querySelector<HTMLButtonElement>("button");
    assert.ok(trigger);
    await React.act(async () =>
        trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
    const hint = document.querySelector<HTMLElement>('[role="tooltip"]');
    assert.ok(hint);
    await React.act(async () =>
        trigger.dispatchEvent(
            new MouseEvent("mouseout", {
                bubbles: true,
                relatedTarget: document.body,
            }),
        ),
    );
    assert.ok(
        document.querySelector('[role="tooltip"]'),
        "Hint must persist while crossing the gap",
    );
    await React.act(async () =>
        hint.dispatchEvent(
            new MouseEvent("mouseover", {
                bubbles: true,
                relatedTarget: document.body,
            }),
        ),
    );
    await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 250)),
    );
    assert.ok(
        document.querySelector('[role="tooltip"]'),
        "Pointer over the hint must keep its content available",
    );
    await React.act(async () =>
        hint.dispatchEvent(
            new MouseEvent("mouseout", {
                bubbles: true,
                relatedTarget: document.body,
            }),
        ),
    );
    await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 250)),
    );
    assert.equal(document.querySelector('[role="tooltip"]'), null);
    await React.act(async () => root.unmount());
    container.remove();
});
