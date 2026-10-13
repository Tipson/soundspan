import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";

GlobalRegistrator.register({ url: "https://soundspan.test/admin" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

let role: "user" | "admin" = "admin";
const getUsers = mock.fn(async () => [
    {
        id: "listener-1",
        username: "listener",
        email: "listener@example.test",
        role: "user",
        hasPassword: true,
        linkedProviders: [],
        createdAt: "2026-10-01T00:00:00Z",
    },
]);
const getInviteCodes = mock.fn(async () => []);
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ user: { id: "owner", role } }) },
});
mock.module("@/lib/api", {
    namedExports: { api: { get: getUsers, getInviteCodes } },
});
mock.module("@/hooks/useSocialPresence", {
    namedExports: {
        useAdminConnectedUsers: () => ({ users: [], isLoading: false }),
    },
});
mock.module("@/components/ui/Modal", {
    namedExports: {
        Modal: ({
            isOpen,
            title,
            children,
            onClose,
        }: {
            isOpen: boolean;
            title: string;
            children: React.ReactNode;
            onClose: () => void;
        }) =>
            isOpen
                ? React.createElement(
                      "div",
                      { role: "dialog", "aria-label": title },
                      children,
                      React.createElement(
                          "button",
                          { onClick: onClose },
                          "Закрыть",
                      ),
                  )
                : null,
    },
});
beforeEach(() => {
    role = "admin";
    getUsers.mock.resetCalls();
    getInviteCodes.mock.resetCalls();
    document.body.replaceChildren();
});

async function mount() {
    const { UserManagementSection } =
        await import("../../features/settings/components/sections/UserManagementSection");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(React.createElement(UserManagementSection));
        await Promise.resolve();
    });
    return {
        container,
        close: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("regular accounts expose no administration and request no private admin data", async () => {
    role = "user";
    const view = await mount();
    assert.equal(view.container.textContent, "");
    assert.equal(getUsers.mock.callCount(), 0);
    assert.equal(getInviteCodes.mock.callCount(), 0);
    await view.close();
});

test("administrator can open and close an account editor from a native keyboard button", async () => {
    const view = await mount();
    const edit = view.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Изменить пользователя listener"]',
    );
    assert.ok(edit, "Account editing must be a native labelled button");
    await React.act(async () => edit.click());
    const dialog = view.container.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(
        dialog.querySelector<HTMLInputElement>("#edit-user-email")?.value,
        "listener@example.test",
    );
    const close = [
        ...dialog.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Закрыть");
    assert.ok(close);
    await React.act(async () => close.click());
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    await view.close();
});
