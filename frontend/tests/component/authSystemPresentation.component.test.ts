import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register({ url: "https://soundspan.test/register" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const replace = mock.fn(() => undefined);
const push = mock.fn(() => undefined);
const register = mock.fn(async () => undefined);
const post = mock.fn(async (path: string) => {
    if (path === "/onboarding/register") {
        return { token: "setup-token", user: { id: "1", username: "admin" } };
    }
    return {};
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({ replace, push }),
        useSearchParams: () => new URLSearchParams(window.location.search),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            alt: props.alt,
            src: typeof props.src === "string" ? props.src : "",
        }),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            get: async () => ({ hasAccount: true }),
            register,
            getOnboardingStatus: async () => ({
                needsOnboarding: true,
                hasAccount: false,
            }),
            getSessionGeneration: () => 1,
            post,
            setToken: () => undefined,
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ user: null, isLoading: false }),
    },
});

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({
            musicCNN: false,
            vibeEmbeddings: false,
            loading: false,
        }),
    },
});

mock.module("@/lib/auth-runtime", {
    namedExports: { revokeAuthenticatedRuntime: () => undefined },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    replace.mock.resetCalls();
    push.mock.resetCalls();
    register.mock.resetCalls();
    post.mock.resetCalls();
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/register");
});

async function settle(): Promise<void> {
    await React.act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
}

async function mount(element: React.ReactElement) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(element));
    await settle();
    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function inputForLabel(container: ParentNode, text: string): HTMLInputElement {
    const label = Array.from(container.querySelectorAll("label")).find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    assert.ok(label instanceof HTMLLabelElement, `Missing ${text} label`);
    const input = container.querySelector(`#${label.htmlFor}`);
    assert.ok(input instanceof HTMLInputElement, `Missing ${text} input`);
    return input;
}

test("shared auth and system states use one spectral presentation", async () => {
    const { AuthPanel, AuthStage } =
        await import("../../features/auth/components/AuthStage");
    const { SystemState } = await import("../../app/_components/SystemState");

    const authHtml = renderToStaticMarkup(
        React.createElement(
            AuthStage,
            null,
            React.createElement(AuthPanel, null, "Вход"),
        ),
    );
    assert.match(authHtml, /data-auth-stage="spectral"/);
    assert.match(authHtml, /Музыка, которая становится вашей/);

    const loadingHtml = renderToStaticMarkup(
        React.createElement(SystemState, {
            kind: "loading",
            title: "Загружаем Soundspan",
            description: "Готовим музыку и ваши настройки.",
        }),
    );
    assert.match(loadingHtml, /data-system-state="loading"/);
    assert.match(loadingHtml, /role="status"/);

    const errorHtml = renderToStaticMarkup(
        React.createElement(SystemState, {
            kind: "error",
            title: "Не удалось открыть страницу",
            description: "Попробуйте ещё раз.",
            action: { label: "Повторить", onClick: () => undefined },
        }),
    );
    assert.match(errorHtml, /data-auth-stage="spectral"/);
    assert.match(errorHtml, /data-system-state="error"/);
    assert.match(errorHtml, /role="alert"/);
    assert.match(errorHtml, /min-h-11/);
});

test("registration keeps labelled mobile-sized controls inside the auth stage", async (t) => {
    const RegisterPage = (await import("../../app/register/page")).default;
    const harness = await mount(React.createElement(RegisterPage));
    t.after(harness.unmount);

    assert.ok(harness.container.querySelector('[data-auth-stage="spectral"]'));
    const username = inputForLabel(harness.container, "Имя пользователя");
    const email = inputForLabel(harness.container, "Электронная почта");
    assert.match(username.className, /min-h-1[12]/);
    assert.equal(username.autocomplete, "username");
    assert.equal(email.autocomplete, "email");
});

test("server onboarding exposes the current step and accessible integration switches", async (t) => {
    window.history.replaceState({}, "", "/onboarding");
    const OnboardingPage = (await import("../../app/onboarding/page")).default;
    const harness = await mount(React.createElement(OnboardingPage));
    t.after(harness.unmount);

    assert.ok(harness.container.querySelector('[data-auth-stage="spectral"]'));
    assert.match(
        harness.container.querySelector('[aria-current="step"]')?.textContent ??
            "",
        /Аккаунт/,
    );
    const username = inputForLabel(harness.container, "Имя пользователя");
    const password = inputForLabel(harness.container, "Пароль");
    const confirmation = inputForLabel(harness.container, "Подтвердите пароль");

    await React.act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
        )?.set;
        assert.ok(setValue);
        setValue.call(username, "admin");
        username.dispatchEvent(new Event("input", { bubbles: true }));
        setValue.call(password, "secret1");
        password.dispatchEvent(new Event("input", { bubbles: true }));
        setValue.call(confirmation, "secret1");
        confirmation.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = username.closest("form");
    assert.ok(form instanceof HTMLFormElement);
    await React.act(async () => {
        form.dispatchEvent(
            new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
    });

    const switches = harness.container.querySelectorAll<HTMLButtonElement>(
        'button[role="switch"]',
    );
    assert.equal(switches.length, 3);
    assert.equal(switches[0]?.getAttribute("aria-checked"), "false");
    assert.match(switches[0]?.className ?? "", /min-h-11/);
});
