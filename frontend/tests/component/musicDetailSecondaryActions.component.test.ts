import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/album/test" });
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("secondary actions stay behind More, escape the hero stacking context, and close after selection", async () => {
    const { MusicDetailSecondaryActions } =
        await import("../../components/music-detail/MusicDetailSecondaryActions");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let calls = 0;
    await act(async () =>
        root.render(
            // Render-prop functions are not ReactNode positional children.
            // eslint-disable-next-line react/no-children-prop
            React.createElement(MusicDetailSecondaryActions, {
                children: (close) =>
                    React.createElement(
                        React.Fragment,
                        null,
                        React.createElement(
                            "button",
                            {
                                onClick: () => {
                                    close();
                                    calls++;
                                },
                            },
                            "Добавить в плейлист",
                        ),
                        React.createElement("button", null, "Скачать"),
                    ),
            }),
        ),
    );
    const trigger = host.querySelector("button");
    assert.ok(trigger);
    assert.equal(trigger.textContent, "Ещё");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => {
        trigger.focus();
        trigger.click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(
        host.contains(dialog),
        false,
        "modal must be outside transformed/blurred hero",
    );
    const buttons = Array.from(dialog.querySelectorAll("button"));
    await act(async () =>
        buttons.find((b) => b.textContent === "Скачать")?.click(),
    );
    assert.ok(
        document.querySelector('[role="dialog"]'),
        "download progress stays visible",
    );
    await act(async () =>
        buttons.find((b) => b.textContent === "Добавить в плейлист")?.click(),
    );
    assert.equal(calls, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () =>
        window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => root.unmount());
    host.remove();
});
