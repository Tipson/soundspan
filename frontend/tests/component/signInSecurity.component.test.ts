import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface IdentityRecord {
    id: string;
    provider: string;
    email: string | null;
    displayName: string | null;
    subjectHint: string;
    createdAt: string;
}

interface AppPasswordRecord {
    id: string;
    displayName: string;
    createdAt: string;
    lastUsedAt: string | null;
}

let oidcEnabled = true;
let identities: IdentityRecord[] = [];
let appPasswords: AppPasswordRecord[] = [];
let unlinkFailure: Error | null = null;

const getAuthConfig = mock.fn(async () => ({
    localLoginEnabled: true,
    oidcEnabled,
    oidcProviderName: "Company SSO",
}));
const getExternalIdentities = mock.fn(async () => ({ identities }));
const startOidcLink = mock.fn(async () => ({
    redirectUrl: `${window.location.origin}/settings#oidc-provider`,
}));
const unlinkExternalIdentity = mock.fn(async (id: string) => {
    if (unlinkFailure) throw unlinkFailure;
    identities = identities.filter((identity) => identity.id !== id);
    return { message: "Identity unlinked" };
});
const listAppPasswords = mock.fn(async () => ({ appPasswords }));
const createAppPassword = mock.fn(async (displayName: string) => {
    const appPassword = {
        id: "app-new",
        displayName,
        createdAt: "2026-08-15T12:00:00.000Z",
        lastUsedAt: null,
        secret: "ssap_once-only-secret",
    };
    appPasswords = [appPassword, ...appPasswords];
    return { appPassword };
});
const revokeAppPassword = mock.fn(async (id: string) => {
    appPasswords = appPasswords.filter((password) => password.id !== id);
    return { message: "App password revoked" };
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getAuthConfig,
            getExternalIdentities,
            startOidcLink,
            unlinkExternalIdentity,
            listAppPasswords,
            createAppPassword,
            revokeAppPassword,
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        }),
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
    oidcEnabled = true;
    identities = [];
    appPasswords = [];
    unlinkFailure = null;
    getAuthConfig.mock.resetCalls();
    getExternalIdentities.mock.resetCalls();
    startOidcLink.mock.resetCalls();
    unlinkExternalIdentity.mock.resetCalls();
    listAppPasswords.mock.resetCalls();
    createAppPassword.mock.resetCalls();
    revokeAppPassword.mock.resetCalls();
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/settings");
});

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function waitForCondition(
    predicate: () => boolean,
    message: string,
): Promise<void> {
    for (let attempt = 0; attempt < 25; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
    }
    assert.fail(message);
}

async function mountSecuritySection() {
    const { SignInSecuritySection } =
        await import("../../features/settings/components/sections/SignInSecuritySection");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(SignInSecuritySection));
        await flushAsyncWork();
    });

    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function findButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

function findLastButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button"))
        .filter((candidate) => candidate.textContent?.trim() === text)
        .at(-1);
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flushAsyncWork();
    });
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    await React.act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

test("renders, links, and unlinks OIDC identities", async (t) => {
    identities = [
        {
            id: "identity-1",
            provider: "oidc:https://idp.example",
            email: "alice@example.com",
            displayName: "Alice Example",
            subjectHint: "subject-…",
            createdAt: "2026-08-10T12:00:00.000Z",
        },
    ];
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    assert.match(harness.container.textContent ?? "", /Company SSO/);
    assert.match(harness.container.textContent ?? "", /Alice Example/);
    assert.match(harness.container.textContent ?? "", /alice@example\.com/);
    assert.match(harness.container.textContent ?? "", /subject-…/);

    await click(findButton("Подключить аккаунт Company SSO"));
    assert.equal(startOidcLink.mock.callCount(), 1);
    await waitForCondition(
        () => window.location.hash === "#oidc-provider",
        "OIDC redirect was not applied",
    );
    assert.equal(window.location.hash, "#oidc-provider");

    await click(findButton("Отвязать"));
    assert.ok(document.querySelector('[role="dialog"]'));
    await click(findLastButton("Отвязать"));

    assert.deepEqual(unlinkExternalIdentity.mock.calls[0]?.arguments, [
        "identity-1",
    ]);
    assert.doesNotMatch(harness.container.textContent ?? "", /Alice Example/);
});

test("surfaces the strand guard when the last sign-in method cannot be unlinked", async (t) => {
    identities = [
        {
            id: "identity-1",
            provider: "oidc:https://idp.example",
            email: "alice@example.com",
            displayName: "Alice Example",
            subjectHint: "subject-…",
            createdAt: "2026-08-10T12:00:00.000Z",
        },
    ];
    unlinkFailure = new Error("Cannot unlink the last sign-in method");
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    await click(findButton("Отвязать"));
    await click(findLastButton("Отвязать"));

    assert.match(
        document.body.textContent ?? "",
        /Нельзя отвязать последний доступный способ входа/,
    );
    assert.match(harness.container.textContent ?? "", /Alice Example/);
});

test("shows the link result once and removes OIDC status parameters", async (t) => {
    window.history.replaceState(
        {},
        "",
        "/settings?keep=1&ssoError=identity_already_linked#sign-in-security",
    );
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    await waitForCondition(
        () =>
            (harness.container.textContent ?? "").includes(
                "Эта учётная запись SSO уже связана с другим аккаунтом",
            ),
        "OIDC link error notice was not rendered",
    );
    assert.match(
        harness.container.textContent ?? "",
        /Эта учётная запись SSO уже связана с другим аккаунтом/,
    );
    assert.equal(window.location.search, "?keep=1");
    assert.equal(window.location.hash, "#sign-in-security");
});

test("shows a successful link result and strips it from the URL", async (t) => {
    window.history.replaceState({}, "", "/settings?ssoLinked=1");
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    await waitForCondition(
        () =>
            (harness.container.textContent ?? "").includes(
                "Аккаунт SSO подключён.",
            ),
        "OIDC link success notice was not rendered",
    );
    assert.match(
        harness.container.textContent ?? "",
        /Аккаунт SSO подключён\./,
    );
    assert.equal(window.location.search, "");
});

test("creates, reveals once, copies, and revokes app passwords", async (t) => {
    oidcEnabled = false;
    appPasswords = [
        {
            id: "app-old",
            displayName: "Kitchen tablet",
            createdAt: "2026-08-01T12:00:00.000Z",
            lastUsedAt: null,
        },
    ];
    const clipboardWrites: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
            writeText: async (value: string) => {
                clipboardWrites.push(value);
            },
        },
    });
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    assert.match(
        harness.container.textContent ?? "",
        /Используйте отдельные пароли в приложениях OpenSubsonic/,
    );
    assert.doesNotMatch(
        harness.container.textContent ?? "",
        /Подключить аккаунт Company SSO/,
    );

    const nameInput = document.querySelector("#app-password-display-name");
    assert.ok(nameInput instanceof HTMLInputElement);
    await typeInto(nameInput, "Bedroom speaker");
    await click(findButton("Создать пароль приложения"));

    assert.deepEqual(createAppPassword.mock.calls[0]?.arguments, [
        "Bedroom speaker",
    ]);
    const secretInput = document.querySelector(
        'input[aria-label="Новый пароль приложения"]',
    );
    assert.ok(secretInput instanceof HTMLInputElement);
    assert.equal(secretInput.value, "ssap_once-only-secret");
    assert.match(
        harness.container.textContent ?? "",
        /повторно он не отображается/i,
    );
    await click(findButton("Копировать"));
    assert.deepEqual(clipboardWrites, ["ssap_once-only-secret"]);
    await click(findButton("Скрыть"));
    assert.equal(
        document.querySelector('input[aria-label="Новый пароль приложения"]'),
        null,
    );

    const revokeButtons = Array.from(
        document.querySelectorAll("button"),
    ).filter((button) => button.textContent?.trim() === "Отозвать");
    assert.ok(revokeButtons[0] instanceof HTMLButtonElement);
    await click(revokeButtons[0]);
    await click(findLastButton("Отозвать"));

    assert.deepEqual(revokeAppPassword.mock.calls[0]?.arguments, ["app-new"]);
    assert.doesNotMatch(harness.container.textContent ?? "", /Bedroom speaker/);
});
