import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register({ url: "https://soundspan.test/admin" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let role = "admin";
const pending = {
    id: "application-1",
    telegram: "listener",
    device: "android",
    createdAt: "2026-09-11T12:00:00Z",
    approvedAt: null,
    status: "pending",
    username: null,
    registrationPath: null,
};
const get = mock.fn(async (_path: string) => ({
    items: [pending],
    nextCursor: null,
}));
const post = mock.fn(async (_path: string) => ({
    ...pending,
    status: "approved",
    registrationPath: "/register?code=INVITE",
}));
mock.module("@/lib/api", { namedExports: { api: { get, post } } });
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ user: { role } }) },
});
beforeEach(() => {
    role = "admin";
    get.mock.resetCalls();
    post.mock.resetCalls();
    document.body.replaceChildren();
});
after(() => GlobalRegistrator.unregister());
async function settle() {
    await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
}
async function mount() {
    const { TestApplicationsSection } =
        await import("../../features/settings/components/sections/TestApplicationsSection");
    const { createRoot } = await import("react-dom/client");
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(TestApplicationsSection),
            ),
        );
    });
    await settle();
    await settle();
    return async () => {
        await React.act(async () => root.unmount());
        client.clear();
        container.remove();
    };
}
test("admin approves a persisted application and receives a copyable personal link", async (t) => {
    t.after(await mount());
    assert.match(document.body.textContent ?? "", /@listener/);
    const button = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "Одобрить",
    );
    assert.ok(button);
    await React.act(async () => button.click());
    await settle();
    assert.equal(
        post.mock.calls[0].arguments[0],
        "/auth/test-applications/application-1/approve",
    );
    const link = document.querySelector<HTMLInputElement>(
        'input[aria-label="Ссылка-приглашение для @listener"]',
    );
    assert.equal(link?.value, "https://soundspan.test/register?code=INVITE");
    assert.match(document.body.textContent ?? "", /Скопировать/);
});
test("non-admin does not request the application list", async (t) => {
    role = "user";
    t.after(await mount());
    assert.equal(get.mock.callCount(), 0);
    assert.equal(document.body.textContent, "");
});
test("list failures are visible and retryable", async (t) => {
    get.mock.mockImplementationOnce(async () => {
        throw new Error("offline");
    });
    t.after(await mount());
    assert.match(
        document.querySelector('[role="alert"]')?.textContent ?? "",
        /Не удалось/,
    );
    assert.ok(
        Array.from(document.querySelectorAll("button")).some(
            (b) => b.textContent === "Обновить",
        ),
    );
});
