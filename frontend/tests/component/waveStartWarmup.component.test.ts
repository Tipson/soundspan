import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const reconcile = mock.fn(
    async (_request: { tail: string[] }, _signal: AbortSignal) => undefined,
);
mock.module("@/lib/api", {
    namedExports: { api: { reconcileYtMusicTailWarmup: reconcile } },
});
after(() => GlobalRegistrator.unregister());

test("visible startup is bounded, handed off on Play, and respects hidden/data-saving states", async () => {
    const { useWaveStartWarmup } =
        await import("../../hooks/useWaveStartWarmup");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container);
    let handoff: () => void = () => undefined;
    function Probe({ enabled }: { enabled: boolean }) {
        handoff = useWaveStartWarmup("dQw4w9WgXcQ", enabled);
        return null;
    }
    const render = async (enabled: boolean) =>
        React.act(async () =>
            root.render(React.createElement(Probe, { enabled })),
        );
    const dwell = async () =>
        React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
    try {
        await render(true);
        assert.equal(reconcile.mock.callCount(), 0);
        await dwell();
        assert.equal(reconcile.mock.callCount(), 1);
        assert.deepEqual(reconcile.mock.calls[0].arguments[0].tail, [
            "dQw4w9WgXcQ",
        ]);
        handoff();
        await render(false);
        assert.equal(
            reconcile.mock.callCount(),
            1,
            "Play must not cancel shared work",
        );
        await render(true);
        await dwell();
        assert.equal(reconcile.mock.callCount(), 2);
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        assert.equal(reconcile.mock.callCount(), 3);
        assert.deepEqual(reconcile.mock.calls[2].arguments[0].tail, []);
        await dwell();
        assert.equal(reconcile.mock.callCount(), 3);
        await render(false);
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
        });
        Object.defineProperty(navigator, "connection", {
            configurable: true,
            value: { saveData: true },
        });
        await render(true);
        await dwell();
        assert.equal(
            reconcile.mock.callCount(),
            3,
            "no speculative traffic with Save Data",
        );
    } finally {
        await React.act(async () => root.unmount());
    }
});
