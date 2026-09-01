import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface TestUser {
    id: string;
    username: string;
    displayName: string;
    role: string;
}

const authenticatedUser: TestUser = {
    id: "user-1",
    username: "listener",
    displayName: "Listener",
    role: "user",
};

let authConfig = {
    localLoginEnabled: true,
    oidcEnabled: true,
    oidcProviderName: "Acme ID",
};
let exchangeBehavior: "success" | "failure" | "pending" = "success";
let confirmBehavior: "success" | "requires2FA" = "success";
let inviteFailuresRemaining = 0;

const login = mock.fn(async () => undefined);
const exchangeOidcCode = mock.fn(async (_code: string) => {
    if (exchangeBehavior === "failure") {
        throw new Error("Invalid or expired OIDC code");
    }
    if (exchangeBehavior === "pending") {
        return new Promise<TestUser>(() => undefined);
    }
    return authenticatedUser;
});
const confirmOidcLink = mock.fn(
    async (_payload: {
        linkToken: string;
        password: string;
        twoFactorToken?: string;
    }) => {
        if (confirmBehavior === "requires2FA") {
            confirmBehavior = "success";
            return {
                requires2FA: true as const,
                message: "2FA token required",
            };
        }
        return authenticatedUser;
    },
);
const redeemOidcInvite = mock.fn(
    async (_payload: { inviteToken: string; inviteCode: string }) => {
        if (inviteFailuresRemaining > 0) {
            inviteFailuresRemaining -= 1;
            throw new Error("Invalid invite code");
        }
        return authenticatedUser;
    },
);

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({ replace: () => undefined, push: () => undefined }),
        useSearchParams: () => new URLSearchParams(window.location.search),
    },
});

mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ login }) },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getAuthConfig: async () => authConfig,
            getOnboardingStatus: async () => ({
                needsOnboarding: false,
                hasAccount: true,
            }),
            getRecentlyListened: async () => ({ items: [] }),
            exchangeOidcCode,
            confirmOidcLink,
            redeemOidcInvite,
        },
    },
});

const Icon = () => React.createElement("span");

mock.module("lucide-react", {
    namedExports: { Loader2: Icon },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            alt: props.alt,
            src: typeof props.src === "string" ? props.src : "",
        }),
});

mock.module("@/components/ui/GalaxyBackground", {
    namedExports: { GalaxyBackground: () => null },
});

const testLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => testLogger,
};

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => testLogger,
        frontendLogger: testLogger,
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
    authConfig = {
        localLoginEnabled: true,
        oidcEnabled: true,
        oidcProviderName: "Acme ID",
    };
    exchangeBehavior = "success";
    confirmBehavior = "success";
    inviteFailuresRemaining = 0;
    login.mock.resetCalls();
    exchangeOidcCode.mock.resetCalls();
    confirmOidcLink.mock.resetCalls();
    redeemOidcInvite.mock.resetCalls();
    document.body.replaceChildren();
    window.location.href = "http://localhost/login";
});

async function settle(): Promise<void> {
    await React.act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) return;
        await settle();
    }
    assert.fail("Timed out waiting for component state");
}

async function mountLoginPage() {
    const LoginPage = (await import("../../app/login/page")).default;
    const { createRoot } = await import("react-dom/client");
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(LoginPage),
            ),
        );
    });
    await settle();

    return {
        unmount: async () => {
            await React.act(async () => root.unmount());
            queryClient.clear();
            container.remove();
        },
    };
}

function findButton(name: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === name,
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${name} button`);
    return button;
}

function findInput(label: string): HTMLInputElement {
    const labelElement = Array.from(document.querySelectorAll("label")).find(
        (candidate) => candidate.textContent?.trim() === label,
    );
    assert.ok(labelElement instanceof HTMLLabelElement, `Missing ${label}`);
    const input = document.getElementById(labelElement.htmlFor);
    assert.ok(input instanceof HTMLInputElement, `Missing ${label} input`);
    return input;
}

function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.click();
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
}

test("shows the configured SSO button and local login form", async (t) => {
    const harness = await mountLoginPage();
    t.after(harness.unmount);
    await waitFor(
        () => document.body.textContent?.includes("Acme ID") === true,
    );

    assert.equal(findButton("Войти через Acme ID").disabled, false);
    assert.ok(findInput("Имя пользователя или почта"));
    assert.ok(document.querySelector('[data-auth-stage="spectral"]'));
});

test("localizes rejected local credentials without exposing backend copy", async (t) => {
    login.mock.mockImplementationOnce(async () => {
        throw new Error("Invalid credentials");
    });
    const harness = await mountLoginPage();
    t.after(harness.unmount);
    await waitFor(() => document.querySelector("#username") !== null);

    await React.act(async () => {
        typeInto(findInput("Имя пользователя или почта"), "listener");
        typeInto(findInput("Пароль"), "wrong-password");
    });
    await click(findButton("Войти"));
    await waitFor(
        () =>
            document.body.textContent?.includes(
                "Неверное имя пользователя или пароль",
            ) === true,
    );

    assert.doesNotMatch(document.body.textContent ?? "", /Invalid credentials/);
});

test("hides the SSO button when OIDC is disabled", async (t) => {
    authConfig.oidcEnabled = false;
    const harness = await mountLoginPage();
    t.after(harness.unmount);
    await waitFor(() => document.querySelector("#username") !== null);

    assert.doesNotMatch(document.body.textContent ?? "", /Войти через Acme ID/);
});

test("hides local credentials when local login is disabled", async (t) => {
    authConfig.localLoginEnabled = false;
    window.location.href = "http://localhost/login?ssoError=oidc_failed";
    const harness = await mountLoginPage();
    t.after(harness.unmount);
    await waitFor(
        () =>
            document.body.textContent?.includes(
                "Не удалось войти через SSO",
            ) === true,
    );

    assert.equal(document.querySelector("#username"), null);
    assert.ok(findButton("Войти через Acme ID"));
});

test("auto-redirects to SSO only when no callback parameter is present", async (t) => {
    authConfig.localLoginEnabled = false;
    window.location.href =
        "http://localhost/login?returnTo=%2Flibrary%3Ftab%3Dalbums";
    const harness = await mountLoginPage();
    t.after(harness.unmount);

    await waitFor(() => window.location.pathname === "/api/auth/oidc/login");
    assert.equal(
        new URLSearchParams(window.location.search).get("returnTo"),
        "/library?tab=albums",
    );
    assert.match(document.body.textContent ?? "", /Переходим к SSO/);
});

test("every callback parameter gates the automatic SSO redirect", async () => {
    authConfig.localLoginEnabled = false;
    exchangeBehavior = "pending";
    const cases = [
        ["ssoCode=pending-code", "Завершаем вход через SSO"],
        [
            "ssoLink=link-token",
            "Аккаунт с этой электронной почтой уже существует",
        ],
        ["ssoInvite=invite-token", "Введите код приглашения"],
        ["ssoError=oidc_failed", "Не удалось войти через SSO"],
    ] as const;

    for (const [query, visibleText] of cases) {
        window.location.href = `http://localhost/login?${query}`;
        const harness = await mountLoginPage();
        await waitFor(
            () => document.body.textContent?.includes(visibleText) === true,
        );
        assert.equal(window.location.pathname, "/login");
        await harness.unmount();
    }
    assert.equal(exchangeOidcCode.mock.callCount(), 1);
});

test("exchanges an SSO code and navigates to a validated returnTo", async (t) => {
    window.location.href =
        "http://localhost/login?ssoCode=exchange-code&returnTo=%2Flibrary";
    const harness = await mountLoginPage();
    t.after(harness.unmount);

    await waitFor(() => window.location.pathname === "/library");
    assert.equal(exchangeOidcCode.mock.callCount(), 1);
    assert.equal(exchangeOidcCode.mock.calls[0].arguments[0], "exchange-code");
});

test("shows a readable error and local form when SSO code exchange fails", async (t) => {
    exchangeBehavior = "failure";
    window.location.href = "http://localhost/login?ssoCode=expired-code";
    const harness = await mountLoginPage();
    t.after(harness.unmount);

    await waitFor(
        () =>
            document.body.textContent?.includes(
                "Код входа через SSO недействителен или истёк",
            ) === true,
    );
    assert.ok(findInput("Имя пользователя или почта"));
    assert.equal(
        new URLSearchParams(window.location.search).has("ssoCode"),
        false,
    );
});

test("confirms an existing-account link through the 2FA branch", async (t) => {
    confirmBehavior = "requires2FA";
    window.location.href =
        "http://localhost/login?ssoLink=link-token&returnTo=%2Fsettings";
    const harness = await mountLoginPage();
    t.after(harness.unmount);
    await waitFor(() => document.querySelector("#oidcLinkPassword") !== null);

    await React.act(async () => {
        typeInto(findInput("Пароль"), "local-password");
    });
    await click(findButton("Связать аккаунт и войти"));
    await waitFor(
        () => document.querySelector("#oidcLinkTwoFactorToken") !== null,
    );

    await React.act(async () => {
        typeInto(findInput("Код из приложения"), "123456");
    });
    await click(findButton("Подтвердить и войти"));
    await waitFor(() => window.location.pathname === "/settings");

    assert.equal(confirmOidcLink.mock.callCount(), 2);
    assert.deepEqual(confirmOidcLink.mock.calls[1].arguments[0], {
        linkToken: "link-token",
        password: "local-password",
        twoFactorToken: "123456",
    });
});

test("keeps the invite form retryable after an invalid code", async (t) => {
    inviteFailuresRemaining = 1;
    window.location.href =
        "http://localhost/login?ssoInvite=invite-token&returnTo=%2Flibrary";
    const harness = await mountLoginPage();
    t.after(harness.unmount);
    await waitFor(() => document.querySelector("#oidcInviteCode") !== null);

    await React.act(async () => {
        typeInto(findInput("Код приглашения"), "BAD-CODE");
    });
    await click(findButton("Создать аккаунт и войти"));
    await waitFor(
        () =>
            document.body.textContent?.includes("Неверный код приглашения") ===
            true,
    );

    assert.equal(findInput("Код приглашения").value, "BAD-CODE");
    await click(findButton("Создать аккаунт и войти"));
    await waitFor(() => window.location.pathname === "/library");
    assert.equal(redeemOidcInvite.mock.callCount(), 2);
});

test("maps and strips SSO callback errors", async (t) => {
    const cases = [
        ["invalid_state", "Сессия входа через SSO истекла"],
        ["account_already_linked", "уже связан с другой учётной записью SSO"],
        ["oidc_failed", "Не удалось войти через SSO"],
        ["unexpected_code", "Не удалось войти через SSO"],
    ] as const;

    for (const [code, message] of cases) {
        window.location.href = `http://localhost/login?ssoError=${code}`;
        const harness = await mountLoginPage();
        await waitFor(
            () => document.body.textContent?.includes(message) === true,
        );
        assert.equal(
            new URLSearchParams(window.location.search).has("ssoError"),
            false,
        );
        await harness.unmount();
    }
    t.after(() => document.body.replaceChildren());
});
