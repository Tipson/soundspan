import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false,
        }),
    });
});

async function mountPrompt() {
    const { PWAInstallPrompt } =
        await import("../../components/PWAInstallPrompt");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(PWAInstallPrompt));
    });

    return {
        container,
        async unmount() {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("explicit install request opens the captured browser install flow", async () => {
    // Suppress the automatic delayed card; an explicit sidebar request must
    // still be honored even after the passive prompt was dismissed.
    localStorage.setItem("pwa-prompt-dismissed", Date.now().toString());
    const mounted = await mountPrompt();
    let promptCalls = 0;
    const beforeInstallPrompt = new Event("beforeinstallprompt", {
        cancelable: true,
    }) as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: "accepted" }>;
    };
    beforeInstallPrompt.prompt = async () => {
        promptCalls += 1;
    };
    beforeInstallPrompt.userChoice = Promise.resolve({ outcome: "accepted" });

    await React.act(async () => {
        window.dispatchEvent(beforeInstallPrompt);
        window.dispatchEvent(new CustomEvent("request-pwa-install"));
    });

    const installButton = Array.from(
        mounted.container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Установить приложение"));
    assert.ok(installButton, "manual request should expose the install action");
    assert.equal(beforeInstallPrompt.defaultPrevented, true);

    await React.act(async () => installButton.click());
    assert.equal(promptCalls, 1);
    assert.match(
        mounted.container.textContent ?? "",
        /Подтверждение установки получено/i,
    );
    const status = mounted.container.querySelector('[role="status"]');
    assert.ok(status, "accepted prompt must expose installation feedback");
    assert.equal(status.getAttribute("aria-live"), "polite");
    assert.doesNotMatch(
        mounted.container.textContent ?? "",
        /уже установлено/i,
    );

    await React.act(async () => {
        window.dispatchEvent(new Event("appinstalled"));
    });
    assert.equal(
        mounted.container.textContent,
        "",
        "the card may close only after appinstalled confirms installation",
    );

    await mounted.unmount();
});

test("capturing the browser install event does not duplicate the sidebar install action", async () => {
    const mounted = await mountPrompt();
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = ((callback: TimerHandler) => {
        if (typeof callback === "function") callback();
        return 1;
    }) as typeof window.setTimeout;
    const beforeInstallPrompt = new Event("beforeinstallprompt", {
        cancelable: true,
    }) as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: "dismissed" }>;
    };
    beforeInstallPrompt.prompt = async () => undefined;
    beforeInstallPrompt.userChoice = Promise.resolve({ outcome: "dismissed" });

    await React.act(async () => {
        window.dispatchEvent(beforeInstallPrompt);
    });
    window.setTimeout = originalSetTimeout;

    assert.equal(
        mounted.container.textContent,
        "",
        "the install UI must open only from the persistent sidebar action",
    );

    await React.act(async () => {
        window.dispatchEvent(new CustomEvent("request-pwa-install"));
    });
    assert.match(mounted.container.textContent ?? "", /Установить приложение/);

    await mounted.unmount();
});

test("PWA prompt clears mobile and desktop player chrome with safe gaps", async () => {
    const mounted = await mountPrompt();

    await React.act(async () => {
        window.dispatchEvent(new CustomEvent("request-pwa-install"));
    });

    const prompt = mounted.container.firstElementChild;
    assert.ok(prompt);
    assert.ok(
        prompt.classList.contains(
            "bottom-[calc(var(--app-mini-player-height)+var(--app-bottom-nav-height)+var(--safe-area-bottom)+12px)]",
        ),
    );
    assert.ok(
        prompt.classList.contains(
            "md:bottom-[calc(var(--app-player-height-desktop)+var(--safe-area-bottom)+12px)]",
        ),
    );

    await mounted.unmount();
});

test("explicit install request explains when this browser has no install prompt", async () => {
    const mounted = await mountPrompt();

    await React.act(async () => {
        window.dispatchEvent(new CustomEvent("request-pwa-install"));
    });

    assert.match(mounted.container.textContent ?? "", /Установка недоступна/);
    assert.doesNotMatch(
        mounted.container.textContent ?? "",
        /Установить приложение/,
    );

    await mounted.unmount();
});

test("explicit install request reports an already installed standalone app", async () => {
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({
            matches: query === "(display-mode: standalone)",
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false,
        }),
    });
    const mounted = await mountPrompt();

    await React.act(async () => {
        window.dispatchEvent(new CustomEvent("request-pwa-install"));
    });

    assert.match(mounted.container.textContent ?? "", /уже установлено/i);

    await mounted.unmount();
});
