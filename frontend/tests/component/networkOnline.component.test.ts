import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useNetworkOnline } from "../../hooks/useNetworkOnline";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

test("connectivity follows offline and online events without changing playback", async () => {
    let online = true;
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => online,
    });
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container);
    function Probe() {
        return React.createElement("p", null, String(useNetworkOnline()));
    }
    try {
        await React.act(async () => root.render(React.createElement(Probe)));
        assert.equal(container.textContent, "true");
        await React.act(async () => {
            online = false;
            window.dispatchEvent(new Event("offline"));
        });
        assert.equal(container.textContent, "false");
        await React.act(async () => {
            online = true;
            window.dispatchEvent(new Event("online"));
        });
        assert.equal(container.textContent, "true");
    } finally {
        await React.act(async () => root.unmount());
    }
});
