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
