import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: () => undefined }) },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", props),
});

mock.module("framer-motion", {
    namedExports: {
        AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
        motion: {
            div: ({
                children,
                initial: _initial,
                animate: _animate,
                exit: _exit,
                transition: _transition,
                ...props
            }: React.HTMLAttributes<HTMLDivElement> & {
                initial?: unknown;
                animate?: unknown;
                exit?: unknown;
                transition?: unknown;
            }) => React.createElement("div", props, children),
        },
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            error: () => undefined,
            success: () => undefined,
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ isAuthenticated: true, isLoading: false }),
    },
});

mock.module("@/lib/listen-together-context", {
    namedExports: {
        useListenTogether: () => ({
            isInGroup: false,
            isLoading: false,
            createGroup: async () => undefined,
            joinGroup: async () => undefined,
            error: "Untranslated backend group error",
            clearError: () => undefined,
            socketRouteStatus: "failed",
            socketRouteError: "Untranslated socket routing error",
            canUseListenTogether: false,
            recheckSocketRoute: async () => undefined,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            discoverListenGroups: async () => [],
            getCoverArtUrl: (path: string) => path,
        },
    },
});

mock.module("@/hooks/useVisibilityGatedInterval", {
    namedExports: { useVisibilityGatedInterval: () => undefined },
});

after(async () => {
    await GlobalRegistrator.unregister();
});

test("лобби совместного прослушивания показывает русский и безопасный runtime-текст", async () => {
    const { default: ListenTogetherPage } =
        await import("../../app/listen-together/page");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(React.createElement(ListenTogetherPage));
            await Promise.resolve();
            await Promise.resolve();
        });

        const copy = container.textContent ?? "";
        assert.match(copy, /Слушаем вместе/);
        assert.match(copy, /Создать группу/);
        assert.match(copy, /Совместное прослушивание недоступно/);
        assert.match(copy, /\/socket\.io\/listen-together/);
        assert.doesNotMatch(copy, /Untranslated backend group error/);
        assert.doesNotMatch(copy, /Untranslated socket routing error/);
        assert.ok(
            container.querySelector('[data-utility-page="listen-together"]'),
        );
        assert.ok(container.querySelector('[data-page-header="editorial"]'));
        assert.ok(container.querySelector('[role="alert"]'));
        assert.ok(
            Array.from(container.querySelectorAll("button")).some((button) =>
                button.className.includes("min-h-11"),
            ),
        );
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});
