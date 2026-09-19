import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://soundspan.test/library" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

async function mount() {
    const { createRoot } = await import("react-dom/client");
    const { useMainScrollRestoration } =
        await import("../../hooks/useMainScrollRestoration");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    mock.method(
        window,
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
            frames.set(++nextFrame, callback);
            return nextFrame;
        },
    );
    mock.method(window, "cancelAnimationFrame", (id: number) =>
        frames.delete(id),
    );
    function Driver({
        route,
        containerRef,
    }: {
        route: string;
        containerRef: React.RefObject<HTMLElement | null>;
    }) {
        useMainScrollRestoration(containerRef, route);
        return null;
    }
    function Harness({ route }: { route: string }) {
        const ref = React.useRef<HTMLElement | null>(null);
        return React.createElement(
            React.Fragment,
            null,
            React.createElement(Driver, { route, containerRef: ref }),
            React.createElement("main", { ref }),
        );
    }
    const render = async (route: string) => {
        await React.act(async () =>
            root.render(React.createElement(Harness, { route })),
        );
    };
    window.history.replaceState(null, "", "/library");
    await render("/library");
    const main = host.querySelector("main");
    assert.ok(main);
    Object.defineProperty(main, "scrollHeight", {
        configurable: true,
        value: 2000,
    });
    Object.defineProperty(main, "clientHeight", {
        configurable: true,
        value: 500,
    });
    return {
        main,
        frames,
        render,
        scroll(top: number) {
            main.scrollTop = top;
            main.dispatchEvent(new Event("scroll"));
        },
        async navigate(route: string, back = false) {
            await React.act(async () => {
                window.history.replaceState(null, "", route);
                if (back) window.dispatchEvent(new PopStateEvent("popstate"));
                main.scrollTop = 0;
                main.dispatchEvent(new Event("scroll"));
                root.render(React.createElement(Harness, { route }));
            });
        },
        async frame() {
            const callbacks = [...frames.values()];
            frames.clear();
            await React.act(async () =>
                callbacks.forEach((callback) => callback(performance.now())),
            );
        },
        async close() {
            await React.act(async () => root.unmount());
            host.remove();
            mock.restoreAll();
        },
    };
}

test("back restores collection position without accepting navigation's automatic reset", async () => {
    const view = await mount();
    try {
        view.scroll(346);
        await view.navigate("/playlist/example");
        view.scroll(900);
        await view.navigate("/library", true);
        await view.frame();
        assert.equal(view.main.scrollTop, 346);
        await view.navigate("/playlist/example", true);
        await view.frame();
        assert.equal(view.main.scrollTop, 900);
    } finally {
        await view.close();
    }
});

test("ordinary navigation and background rerenders do not restore an old position", async () => {
    const view = await mount();
    try {
        view.scroll(346);
        await view.navigate("/playlist/example");
        await view.navigate("/library");
        await view.frame();
        assert.equal(view.main.scrollTop, 0);
        view.scroll(150);
        await view.render("/library");
        await view.frame();
        assert.equal(view.main.scrollTop, 150);
    } finally {
        await view.close();
    }
});

test("query routes retain distinct positions", async () => {
    const view = await mount();
    try {
        await view.navigate("/library?tab=artists");
        view.scroll(260);
        await view.navigate("/library?tab=albums");
        view.scroll(80);
        await view.navigate("/library?tab=artists", true);
        await view.frame();
        assert.equal(view.main.scrollTop, 260);
    } finally {
        await view.close();
    }
});

test("back restores when the router commits before our popstate listener runs", async () => {
    const view = await mount();
    try {
        view.scroll(346);
        await view.navigate("/playlist/example");
        // Next's earlier listener can synchronously commit the new pathname.
        window.history.replaceState(null, "", "/library");
        await view.render("/library");
        await React.act(async () =>
            window.dispatchEvent(new PopStateEvent("popstate")),
        );
        await view.frame();
        assert.equal(view.main.scrollTop, 346);
    } finally {
        await view.close();
    }
});

test("a popstate render before the router commit retains the pending destination", async () => {
    const view = await mount();
    try {
        view.scroll(346);
        await view.navigate("/playlist/example");
        window.history.replaceState(null, "", "/library");
        await React.act(async () =>
            window.dispatchEvent(new PopStateEvent("popstate")),
        );
        await view.frame();
        assert.equal(view.main.scrollTop, 0);
        await view.render("/library");
        await view.frame();
        assert.equal(view.main.scrollTop, 346);
    } finally {
        await view.close();
    }
});

test("restoration waits for content, but stops when the user scrolls", async () => {
    const view = await mount();
    try {
        view.scroll(600);
        await view.navigate("/playlist/example");
        Object.defineProperty(view.main, "scrollHeight", {
            configurable: true,
            value: 550,
        });
        await view.navigate("/library", true);
        await view.frame();
        assert.ok(view.frames.size > 0);
        view.main.dispatchEvent(new WheelEvent("wheel"));
        view.scroll(30);
        Object.defineProperty(view.main, "scrollHeight", {
            configurable: true,
            value: 2000,
        });
        await view.frame();
        assert.equal(view.main.scrollTop, 30);
        assert.equal(view.frames.size, 0);
    } finally {
        await view.close();
    }
});

test("unmount cancels pending restoration", async () => {
    const view = await mount();
    view.scroll(600);
    await view.navigate("/playlist/example");
    await view.navigate("/library", true);
    assert.ok(view.frames.size > 0);
    await view.close();
    assert.equal(view.frames.size, 0);
});

test("content arriving during restoration restores the saved position", async () => {
    const view = await mount();
    try {
        view.scroll(600);
        await view.navigate("/playlist/example");
        Object.defineProperty(view.main, "scrollHeight", {
            configurable: true,
            value: 550,
        });
        await view.navigate("/library", true);
        await view.frame();
        Object.defineProperty(view.main, "scrollHeight", {
            configurable: true,
            value: 2000,
        });
        await view.frame();
        assert.equal(view.main.scrollTop, 600);
        assert.equal(view.frames.size, 0);
    } finally {
        await view.close();
    }
});

test("unavailable content cannot keep restoration alive beyond its deadline", async () => {
    const view = await mount();
    try {
        let now = 0;
        mock.method(performance, "now", () => now);
        view.scroll(600);
        await view.navigate("/playlist/example");
        Object.defineProperty(view.main, "scrollHeight", {
            configurable: true,
            value: 550,
        });
        await view.navigate("/library", true);
        await view.frame();
        now = 2001;
        await view.frame();
        assert.equal(view.frames.size, 0);
    } finally {
        await view.close();
    }
});

test("a new account shell does not inherit another shell's saved positions", async () => {
    const previous = await mount();
    previous.scroll(600);
    await previous.close();
    const next = await mount();
    try {
        await next.navigate("/playlist/example");
        await next.navigate("/library", true);
        await next.frame();
        assert.equal(next.main.scrollTop, 0);
    } finally {
        await next.close();
    }
});
