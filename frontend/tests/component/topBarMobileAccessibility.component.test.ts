import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Icon = () => React.createElement("svg");
const state = {
    pathname: "/library",
    routeQuery: "",
    isMobile: true,
    isTablet: false,
    routerPushes: [] as string[],
};

mock.module("lucide-react", {
    namedExports: {
        Home: Icon,
        AudioWaveform: Icon,
        Library: Icon,
        Search: Icon,
        Menu: Icon,
        Bell: Icon,
        ChevronLeft: Icon,
    },
});
mock.module("next/navigation", {
    namedExports: {
        usePathname: () => state.pathname,
        useRouter: () => ({
            back() {},
            push(path: string) {
                state.routerPushes.push(path);
            },
        }),
        useSearchParams: () => ({
            get: (key: string) => (key === "q" ? state.routeQuery : null),
        }),
    },
});
mock.module("next/link", {
    defaultExport: ({ href, children, ...props }: React.ComponentProps<"a">) =>
        React.createElement("a", { href, ...props }, children),
});
mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", props),
});
mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => state.isMobile,
        useIsTablet: () => state.isTablet,
    },
});

beforeEach(() => {
    state.pathname = "/library";
    state.routeQuery = "";
    state.isMobile = true;
    state.isTablet = false;
    state.routerPushes.length = 0;
});
after(() => GlobalRegistrator.unregister());
mock.module("@/components/layout/ActivityPanel", {
    namedExports: { ActivityPanelToggle: () => null },
});
mock.module("@/components/layout/UserAvatarMenu", {
    namedExports: { UserAvatarMenu: () => null },
});
mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

test("mobile top bar keeps menu, identity, and search action at 320px", async () => {
    const { TopBar } = await import("../../components/layout/TopBar");
    const html = renderToStaticMarkup(React.createElement(TopBar));

    assert.match(html, /padding-top:var\(--safe-area-top\)/);
    assert.match(
        html,
        /padding-left:calc\(0\.75rem \+ var\(--safe-area-left\)\)/,
    );
    assert.match(
        html,
        /padding-right:calc\(0\.75rem \+ var\(--safe-area-right\)\)/,
    );
    for (const label of ["Открыть меню", "Поиск"]) {
        const control = html.match(
            new RegExp(`<(?:button|a)[^>]*aria-label="${label}"[^>]*>`),
        )?.[0];
        assert.ok(control, `missing ${label}`);
        assert.match(control, /h-11 w-11/);
    }
    assert.doesNotMatch(html, /aria-label="Назад"/);
    assert.doesNotMatch(html, /aria-label="Главная"/);
    assert.doesNotMatch(html, /aria-label="Уведомления"/);
    assert.match(html, /href="\/search"/);
    assert.match(html, /data-shell-search="action"/);
    assert.doesNotMatch(html, /placeholder="Поиск музыки"/);
    assert.match(html, /soundspan/i);
    assert.match(html, /data-shell-topbar="mobile"/);
    assert.match(html, /data-shell-spectral-seam="true"/);
});

test("mobile search destination expands into the focused result field", async () => {
    state.pathname = "/search";

    const { TopBar } = await import("../../components/layout/TopBar");
    const html = renderToStaticMarkup(React.createElement(TopBar));

    assert.match(html, /data-shell-search="canvas"/);
    assert.match(html, /aria-label="Поиск"[^>]*class="[^"]*h-11/);
    assert.match(html, /placeholder="Поиск музыки"/);
    assert.doesNotMatch(html, /data-shell-search="action"/);
});

test("mobile search keeps newer typed text when an older route update arrives", async () => {
    state.pathname = "/search";
    const { TopBar } = await import("../../components/layout/TopBar");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const render = async () => {
        await act(async () => root.render(React.createElement(TopBar)));
    };
    const enter = async (value: string) => {
        const input = container.querySelector<HTMLInputElement>(
            'input[aria-label="Поиск"]',
        );
        assert.ok(input);
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                "value",
            )?.set;
            assert.ok(setter);
            setter.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
    };

    await render();
    await enter("The");
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 550));
    });
    assert.deepEqual(state.routerPushes, ["/search?q=The"]);

    await enter("The Cranberries");
    state.routeQuery = "The";
    await render();

    assert.equal(
        container.querySelector<HTMLInputElement>('input[aria-label="Поиск"]')
            ?.value,
        "The Cranberries",
    );

    await act(async () => root.unmount());
    container.remove();
});

test("desktop top bar centers persistent search without duplicating sidebar navigation", async () => {
    state.isMobile = false;

    const { TopBar } = await import("../../components/layout/TopBar");
    const html = renderToStaticMarkup(React.createElement(TopBar));

    assert.match(html, /data-shell-topbar="desktop"/);
    assert.doesNotMatch(html, /data-shell-top-navigation="desktop"/);
    for (const href of ["/", "/vibe", "/library"]) {
        assert.doesNotMatch(
            html,
            new RegExp(
                `href="${href === "/" ? "\\/" : href.replaceAll("/", "\\/")}"`,
            ),
        );
    }
    assert.doesNotMatch(html, />Главная</);
    assert.doesNotMatch(html, />Волна</);
    assert.doesNotMatch(html, />Моя музыка</);
    assert.match(
        html,
        /placeholder="Найти трек, исполнителя, альбом или плейлист"/,
    );
    assert.match(
        html,
        /grid-cols-\[minmax\(0,1fr\)_minmax\(16rem,520px\)_minmax\(0,1fr\)\]/,
    );
    assert.match(html, /max-w-\[520px\]/);
    assert.doesNotMatch(html, /w-\[216px\]/);
    assert.doesNotMatch(html, /aria-label="Назад"/);
    assert.match(html, />\/<\/kbd>/);
    assert.match(html, /data-shell-search="persistent"/);
    assert.match(html, /data-shell-spectral-seam="true"/);
});
