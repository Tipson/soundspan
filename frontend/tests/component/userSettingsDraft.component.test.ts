import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
let finishSave: (() => void) | undefined;
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ isAuthenticated: true }) },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getSettings: async () => ({
                displayName: "Listener",
                playbackQuality: "original",
                loudnessMode: "auto",
            }),
            updateSettings: async () =>
                new Promise<void>((resolve) => {
                    finishSave = resolve;
                }),
        },
    },
});

test("settings dirty state reflects persisted values and preserves edits made during save", async () => {
    const { createRoot } = await import("react-dom/client");
    const { useSettingsData } =
        await import("../../features/settings/hooks/useSettingsData");
    let state: ReturnType<typeof useSettingsData> | undefined;
    function Probe() {
        state = useSettingsData();
        return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    await React.act(async () =>
        root.render(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        ),
    );
    assert.ok(state);
    assert.equal(state.hasChanges, false);
    await React.act(async () =>
        state!.updateSettings({ displayName: "Changed" }),
    );
    assert.equal(state.hasChanges, true);
    await React.act(async () =>
        state!.updateSettings({ displayName: "Listener" }),
    );
    assert.equal(state.hasChanges, false);
    await React.act(async () =>
        state!.updateSettings({ displayName: "First edit" }),
    );
    let saving: Promise<void>;
    await React.act(async () => {
        saving = state!.saveSettings(state!.settings);
    });
    await React.act(async () =>
        state!.updateSettings({ displayName: "Second edit" }),
    );
    await React.act(async () => {
        finishSave!();
        await saving;
    });
    assert.equal(state.settings.displayName, "Second edit");
    assert.equal(state.hasChanges, true);
    await React.act(async () => {
        saving = state!.saveSettings(state!.settings);
    });
    await React.act(async () => {
        finishSave!();
        await saving;
    });
    assert.equal(state.hasChanges, false);
    await React.act(async () => root.unmount());
    client.clear();
});
