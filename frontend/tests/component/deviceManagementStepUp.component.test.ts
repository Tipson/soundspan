import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let generateFailure: Error | null = null;
const request = mock.fn(async (endpoint: string, options?: RequestInit) => {
    if (endpoint === "/device-link/devices" && !options?.method) {
        return [
            {
                id: "device-1",
                name: "Living Room",
                lastUsed: "2026-08-12T00:00:00.000Z",
                createdAt: "2026-08-01T00:00:00.000Z",
            },
        ];
    }
    if (endpoint === "/device-link/generate" && generateFailure) {
        throw generateFailure;
    }
    if (endpoint === "/device-link/devices/device-1") {
        throw new Error("Interactive session authentication required");
    }
    return {};
});

mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: () => undefined }) },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ isAuthenticated: true, isLoading: false }),
    },
});

mock.module("@/hooks/useVisibilityGatedInterval", {
    namedExports: { useVisibilityGatedInterval: () => undefined },
});

mock.module("@/lib/api", { namedExports: { api: { request } } });

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    generateFailure = null;
    request.mock.resetCalls();
    document.body.replaceChildren();
});

async function mountDevicePage() {
    const { default: DeviceLinkPage } = await import("../../app/device/page");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(DeviceLinkPage));
        await Promise.resolve();
        await Promise.resolve();
    });

    return {
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function findButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
            candidate.textContent?.trim() === text || candidate.title === text,
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("показывает русское сообщение при запрете отвязки устройства", async (t) => {
    const harness = await mountDevicePage();
    t.after(harness.unmount);

    assert.ok(document.querySelector('[data-consumer-surface="device"]'));
    assert.ok(document.querySelector('[data-page-header="editorial"]'));
    assert.ok(
        Array.from(document.querySelectorAll("button")).every(
            (button) =>
                button.className.includes("min-h-11") ||
                button.className.includes("h-11") ||
                button.className.includes("size-11"),
        ),
    );
    await click(findButton("Отвязать устройство"));

    assert.match(
        document.body.textContent ?? "",
        /Для этого действия снова войдите в аккаунт/,
    );
    assert.doesNotMatch(
        document.body.textContent ?? "",
        /Interactive session authentication required/,
    );
});

test("показывает русское сообщение при запрете создания кода", async (t) => {
    generateFailure = new Error("Interactive session authentication required");
    const harness = await mountDevicePage();
    t.after(harness.unmount);

    await click(findButton("Создать код"));

    assert.match(
        document.body.textContent ?? "",
        /Для этого действия снова войдите в аккаунт/,
    );
    assert.doesNotMatch(
        document.body.textContent ?? "",
        /Interactive session authentication required/,
    );
});

test("не показывает неизвестную английскую ошибку backend", async (t) => {
    generateFailure = new Error("Untranslated backend device error");
    const harness = await mountDevicePage();
    t.after(harness.unmount);

    await click(findButton("Создать код"));

    assert.match(
        document.body.textContent ?? "",
        /Не удалось создать код привязки/,
    );
    assert.doesNotMatch(
        document.body.textContent ?? "",
        /Untranslated backend device error/,
    );
});
