import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = () => React.createElement("svg");
const state = {
    pathname: "/library",
    isMobile: true,
    isTablet: false,
};

mock.module("lucide-react", {
    namedExports: {
        Home: Icon,
        Search: Icon,
        Menu: Icon,
        Bell: Icon,
        ChevronLeft: Icon,
    },
});
mock.module("next/navigation", {
    namedExports: {
        usePathname: () => state.pathname,
        useRouter: () => ({ back() {}, push() {} }),
        useSearchParams: () => ({ get: () => null }),
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
    state.isMobile = true;
    state.isTablet = false;
});
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

test("mobile top bar keeps only menu and persistent search at 320px", async () => {
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
    for (const label of ["Открыть меню"]) {
        const control = html.match(
            new RegExp(`<(?:button|a)[^>]*aria-label="${label}"[^>]*>`),
        )?.[0];
        assert.ok(control, `missing ${label}`);
        assert.match(control, /h-11 w-11/);
    }
    assert.doesNotMatch(html, /aria-label="Назад"/);
    assert.doesNotMatch(html, /aria-label="Главная"/);
    assert.doesNotMatch(html, /aria-label="Уведомления"/);
    assert.match(html, /aria-label="Поиск"[^>]*class="[^"]*h-11/);
    assert.match(html, /placeholder="Поиск музыки"/);
    assert.match(html, /data-shell-topbar="mobile"/);
    assert.match(html, /data-shell-search="persistent"/);
});

test("desktop top bar keeps global search centered in the music shell", async () => {
    state.isMobile = false;

    const { TopBar } = await import("../../components/layout/TopBar");
    const html = renderToStaticMarkup(React.createElement(TopBar));

    assert.match(html, /data-shell-topbar="desktop"/);
    assert.match(html, /placeholder="Что хотите послушать\?"/);
    assert.match(html, /max-w-\[720px\]/);
    assert.match(html, /w-\[224px\]/);
    assert.match(html, /aria-label="Назад"/);
    assert.match(html, />\/<\/kbd>/);
    assert.match(html, /data-shell-search="persistent"/);
});
