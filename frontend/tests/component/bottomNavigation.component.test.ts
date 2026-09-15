import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = () => React.createElement("svg");
type LinkClick = {
    button: number;
    preventDefault: () => void;
};
let libraryClick: ((event: LinkClick) => void) | undefined;

mock.module("lucide-react", {
    namedExports: {
        Home: Icon,
        Search: Icon,
        AudioWaveform: Icon,
        Library: Icon,
        HardDriveDownload: Icon,
        BookOpen: Icon,
        Mic: Icon,
        ListMusic: Icon,
    },
});

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        onClick,
        ...props
    }: {
        href: string;
        children: React.ReactNode;
        onClick?: (event: LinkClick) => void;
        [key: string]: unknown;
    }) => {
        if (href === "/library") libraryClick = onClick;
        return React.createElement("a", { href, onClick, ...props }, children);
    },
});

mock.module("next/navigation", {
    namedExports: { usePathname: () => "/vibe" },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => true,
        useIsTablet: () => false,
    },
});

test("mobile navigation keeps search in the persistent header", async () => {
    const { BottomNavigation } =
        await import("../../components/layout/BottomNavigation");
    const html = renderToStaticMarkup(React.createElement(BottomNavigation));

    assert.match(html, /aria-label="Главная"/);
    assert.doesNotMatch(html, /aria-label="Поиск"/);
    assert.doesNotMatch(html, /href="\/search"/);
    assert.match(html, /aria-label="Волна"/);
    assert.match(html, /href="\/vibe"/);
    assert.match(html, /aria-label="Моя музыка"/);
    assert.match(html, /href="\/library"/);
    assert.match(html, /aria-label="Волна" aria-current="page"/);
    assert.doesNotMatch(html, /aria-label="Обзор"/);
    assert.doesNotMatch(html, /Аудиокниги/);
    assert.doesNotMatch(html, /Подкасты/);
    assert.doesNotMatch(html, /Плейлисты/);
    assert.match(html, /padding-left:var\(--safe-area-left\)/);
    assert.match(html, /padding-right:var\(--safe-area-right\)/);
    assert.match(html, /data-shell-bottom-navigation="true"/);
    const navigation = html.match(
        /<nav[^>]*data-shell-bottom-navigation="true"[^>]*>/,
    )?.[0];
    assert.ok(navigation);
    assert.doesNotMatch(navigation, /border-t/);
    for (const label of ["Главная", "Волна", "Моя музыка"]) {
        const link = html.match(
            new RegExp(`<a[^>]*aria-label="${label}"[^>]*>`),
        )?.[0];
        assert.ok(link, `missing ${label}`);
        assert.match(link, /min-h-11/);
    }

    assert.equal(
        (html.match(/data-shell-primary-destination=/g) ?? []).length,
        3,
    );
    assert.equal((html.match(/<(?:a|button)\b/g) ?? []).length, 4);
    assert.match(html, /<button[^>]*aria-haspopup="dialog"/);
    assert.match(html, /Загруженное/);

    assert.ok(libraryClick);
    const hardNavigations: string[] = [];
    const localActions: string[] = [];
    const preventDefault = mock.fn();
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "navigator",
    );
    const windowDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "window",
    );
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { onLine: false },
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            dispatchEvent: (event: Event) => {
                localActions.push(event.type);
                return true;
            },
            location: {
                assign: (path: string) => hardNavigations.push(path),
            },
        },
    });
    try {
        libraryClick({ button: 0, preventDefault });
    } finally {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
        if (windowDescriptor) {
            Object.defineProperty(globalThis, "window", windowDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }
    }
    assert.equal(preventDefault.mock.callCount(), 1);
    assert.deepEqual(hardNavigations, []);
    assert.deepEqual(localActions, ["open-device-downloads"]);
});
