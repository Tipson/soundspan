import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = () => React.createElement("svg");
let libraryClick: ((event: { preventDefault: () => void }) => void) | undefined;

mock.module("lucide-react", {
    namedExports: {
        Home: Icon,
        Search: Icon,
        Compass: Icon,
        Library: Icon,
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
        onClick?: (event: { preventDefault: () => void }) => void;
        [key: string]: unknown;
    }) => {
        if (href === "/library") libraryClick = onClick;
        return React.createElement("a", { href, onClick, ...props }, children);
    },
});

mock.module("next/navigation", {
    namedExports: { usePathname: () => "/explore" },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => true,
        useIsTablet: () => false,
    },
});

test("mobile navigation prioritizes the four music discovery destinations", async () => {
    const { BottomNavigation } =
        await import("../../components/layout/BottomNavigation");
    const html = renderToStaticMarkup(React.createElement(BottomNavigation));

    assert.match(html, /aria-label="Home"/);
    assert.match(html, /href="\/search"/);
    assert.match(html, /aria-label="Explore"/);
    assert.match(html, /aria-label="Library"/);
    assert.match(html, /href="\/library"/);
    assert.match(html, /aria-label="Explore" aria-current="page"/);
    assert.doesNotMatch(html, /Audiobooks/);
    assert.doesNotMatch(html, /Podcasts/);
    assert.doesNotMatch(html, /Playlists/);

    assert.ok(libraryClick);
    const hardNavigations: string[] = [];
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
            location: {
                assign: (path: string) => hardNavigations.push(path),
            },
        },
    });
    try {
        libraryClick({ preventDefault });
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
    assert.deepEqual(hardNavigations, ["/library?tab=downloads"]);
});
