import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

test("shared input associates its visible label and error with the field", async () => {
    const { createRoot } = await import("react-dom/client");
    const { Input } = await import("../../components/ui/Input");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await React.act(async () =>
            root.render(
                React.createElement(Input, {
                    label: "Название плейлиста",
                    error: "Укажите название",
                    "aria-describedby": "playlist-hint",
                }),
            ),
        );
        const label = container.querySelector("label");
        const input = container.querySelector("input");
        assert.ok(label);
        assert.ok(input);
        assert.ok(label.control === input, "label activates the input");
        assert.equal(input.getAttribute("aria-invalid"), "true");
        const descriptions =
            input.getAttribute("aria-describedby")?.split(" ") ?? [];
        assert.ok(
            descriptions.includes("playlist-hint"),
            "caller description retained",
        );
        assert.ok(
            descriptions.some(
                (id) =>
                    document.getElementById(id)?.textContent ===
                    "Укажите название",
            ),
            "error announced for the input",
        );
        await React.act(async () =>
            root.render(
                React.createElement(Input, {
                    id: "explicit-name",
                    label: "Название плейлиста",
                }),
            ),
        );
        assert.equal(
            container.querySelector("label")?.htmlFor,
            "explicit-name",
        );
        assert.equal(
            container.querySelector("input")?.hasAttribute("aria-invalid"),
            false,
        );
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});
