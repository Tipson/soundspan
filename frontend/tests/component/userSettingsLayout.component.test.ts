import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

test("user settings have four sections, keep drafts, and restore legacy deep links", async () => {
    const { createRoot } = await import("react-dom/client");
    const { UserSettingsLayout } =
        await import("../../features/settings/components/UserSettingsLayout");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () =>
        root.render(
            React.createElement(UserSettingsLayout, {
                sections: {
                    profile: React.createElement("input", {
                        "aria-label": "Имя",
                        defaultValue: "Listener",
                    }),
                    playback: React.createElement("p", null, "Качество звука"),
                    offline: React.createElement("p", null, "Мои загрузки"),
                    security: React.createElement("p", null, "Защита входа"),
                },
            }),
        ),
    );
    const tabs = [
        ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    assert.deepEqual(
        tabs.map((tab) => tab.textContent),
        ["Профиль", "Прослушивание", "Офлайн", "Безопасность"],
    );
    const name = container.querySelector<HTMLInputElement>(
        'input[aria-label="Имя"]',
    )!;
    name.value = "Новый черновик";
    await React.act(async () => tabs[2].click());
    assert.equal(window.location.hash, "#device-offline");
    assert.equal(
        container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent,
        "Мои загрузки",
    );
    await React.act(async () =>
        tabs[2].dispatchEvent(
            new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
        ),
    );
    assert.equal(tabs[0].getAttribute("aria-selected"), "true");
    assert.ok(
        document.activeElement === tabs[0],
        "Home moves keyboard focus to Profile",
    );
    assert.equal(
        container.querySelector<HTMLInputElement>('input[aria-label="Имя"]')
            ?.value,
        "Новый черновик",
    );
    window.history.replaceState({}, "", "/settings#api-keys");
    await React.act(async () =>
        window.dispatchEvent(new PopStateEvent("popstate")),
    );
    assert.equal(tabs[3].getAttribute("aria-selected"), "true");
    assert.equal(
        container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent,
        "Защита входа",
    );
    window.history.replaceState({}, "", "/settings#toString");
    await React.act(async () =>
        window.dispatchEvent(new PopStateEvent("popstate")),
    );
    assert.equal(tabs[0].getAttribute("aria-selected"), "true");
    await React.act(async () => root.unmount());
    container.remove();
});
