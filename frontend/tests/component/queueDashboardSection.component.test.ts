import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register({ url: "https://music.example/admin" });
const actEnvironment = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    writable: true,
    configurable: true,
});
after(() => {
    if (actEnvironment)
        Object.defineProperty(
            globalThis,
            "IS_REACT_ACT_ENVIRONMENT",
            actEnvironment,
        );
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    GlobalRegistrator.unregister();
});

let role = "admin";
let createSession: (
    signal?: AbortSignal,
) => Promise<{ expiresIn: number }> = async () => ({ expiresIn: 900 });
let endSession = async () => undefined;
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ user: { role } }) },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            createQueueDashboardSession: (signal?: AbortSignal) =>
                createSession(signal),
            endQueueDashboardSession: () => endSession(),
            getQueueDashboardUrl: () =>
                "https://api.music.example/api/admin/queues",
        },
    },
});

beforeEach(() => {
    role = "admin";
    createSession = async () => ({ expiresIn: 900 });
    endSession = async () => undefined;
});

type Popup = {
    opener: unknown;
    closed: boolean;
    location: { replace(url: string): void };
    close(): void;
};

async function renderPanel(openWindow?: () => Popup | null) {
    const { QueueDashboardSection } =
        await import("../../features/settings/components/sections/QueueDashboardSection");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () =>
        root.render(
            React.createElement(
                QueueDashboardSection,
                openWindow ? { openWindow } : {},
            ),
        ),
    );
    return {
        container,
        dispose: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const element = Array.from(container.querySelectorAll("button")).find(
        (node) => node.textContent?.includes(label),
    );
    assert.ok(element instanceof HTMLButtonElement, `Expected action ${label}`);
    return element;
}

test("ordinary listeners do not see administrator queue actions", async () => {
    role = "user";
    const panel = await renderPanel();
    try {
        assert.equal(panel.container.querySelector("section"), null);
    } finally {
        await panel.dispose();
    }
});

test("blocked popup gives a recovery message without minting an unused session", async (context) => {
    const panel = await renderPanel();
    let minted = false;
    createSession = async () => {
        minted = true;
        return { expiresIn: 900 };
    };
    const openMock = context.mock.method(window, "open", () => null);
    try {
        await React.act(async () =>
            button(panel.container, "Открыть панель").click(),
        );
        assert.equal(minted, false);
        assert.match(
            panel.container.querySelector('[role="alert"]')?.textContent ?? "",
            /разрешите.*вклад/i,
        );
    } finally {
        openMock.mock.restore();
        await panel.dispose();
    }
});

test("opening detaches the opener and navigates only after the authenticated session is ready", async () => {
    let destination = "";
    const popup: Popup = {
        opener: "original",
        closed: false,
        location: {
            replace: (url) => {
                destination = url;
            },
        },
        close: () => {
            popup.closed = true;
        },
    };
    const panel = await renderPanel(() => popup);
    let finish: ((value: { expiresIn: number }) => void) | undefined;
    createSession = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    try {
        await React.act(async () =>
            button(panel.container, "Открыть панель").click(),
        );
        assert.equal(popup.opener, null);
        assert.equal(destination, "");
        assert.equal(
            button(panel.container, "Открываем панель").disabled,
            true,
        );
        assert.equal(
            button(panel.container, "Завершить доступ").disabled,
            true,
        );
        await React.act(async () => {
            assert.ok(finish);
            finish({ expiresIn: 900 });
        });
        assert.equal(destination, "https://api.music.example/api/admin/queues");
        assert.match(
            panel.container.querySelector('[role="status"]')?.textContent ?? "",
            /панель открыта/i,
        );
    } finally {
        popup.close();
        await panel.dispose();
    }
});

test("a failed session closes the blank tab and offers retry", async () => {
    const popup: Popup = {
        opener: null,
        closed: false,
        location: { replace: () => undefined },
        close: () => {
            popup.closed = true;
        },
    };
    const panel = await renderPanel(() => popup);
    createSession = async () => {
        throw new Error("fixture unavailable");
    };
    try {
        await React.act(async () =>
            button(panel.container, "Открыть панель").click(),
        );
        assert.equal(popup.closed, true);
        assert.match(
            panel.container.querySelector('[role="alert"]')?.textContent ?? "",
            /повторите/i,
        );
        assert.equal(button(panel.container, "Открыть панель").disabled, false);
    } finally {
        popup.close();
        await panel.dispose();
    }
});

test("leaving the admin view aborts an unfinished opening and closes its blank tab", async () => {
    const popup: Popup = {
        opener: null,
        closed: false,
        location: { replace: () => undefined },
        close: () => {
            popup.closed = true;
        },
    };
    let signal: AbortSignal | undefined;
    let finish: ((value: { expiresIn: number }) => void) | undefined;
    createSession = (value) => {
        signal = value;
        return new Promise((resolve) => {
            finish = resolve;
        });
    };
    const panel = await renderPanel(() => popup);
    await React.act(async () =>
        button(panel.container, "Открыть панель").click(),
    );
    await panel.dispose();
    assert.equal(signal?.aborted, true);
    assert.equal(popup.closed, true);
    await React.act(async () => {
        assert.ok(finish);
        finish({ expiresIn: 900 });
    });
});

test("administrator can end browser dashboard access", async () => {
    const panel = await renderPanel();
    let ended = false;
    endSession = async () => {
        ended = true;
    };
    try {
        await React.act(async () =>
            button(panel.container, "Завершить доступ").click(),
        );
        assert.equal(ended, true);
        assert.match(
            panel.container.querySelector('[role="status"]')?.textContent ?? "",
            /доступ завершён/i,
        );
    } finally {
        await panel.dispose();
    }
});

test("ending access reports an error and keeps the action available for retry", async () => {
    const panel = await renderPanel();
    endSession = async () => {
        throw new Error("fixture unavailable");
    };
    try {
        await React.act(async () =>
            button(panel.container, "Завершить доступ").click(),
        );
        assert.match(
            panel.container.querySelector('[role="alert"]')?.textContent ?? "",
            /повторите/i,
        );
        assert.equal(
            button(panel.container, "Завершить доступ").disabled,
            false,
        );
    } finally {
        await panel.dispose();
    }
});
