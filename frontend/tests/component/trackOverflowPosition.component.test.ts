import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    installTrackOverflowHarness,
    trackOverflowIcon,
} from "../trackOverflowHarness";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const queued: string[] = [];
const track = {
    id: "only-track",
    title: "Единственный трек",
    duration: 180,
    artist: { id: "artist-1", name: "Исполнитель" },
    album: { id: "album-1", title: "Альбом" },
};
mock.module("lucide-react", {
    namedExports: Object.fromEntries(
        [
            "EllipsisVertical",
            "Link",
            "ListEnd",
            "ListPlus",
            "Map",
            "Plus",
            "Share2",
            "User",
            "Disc3",
            "AudioWaveform",
            "Radio",
            "Check",
            "Download",
            "Loader2",
        ].map((name) => [name, trackOverflowIcon]),
    ),
});
installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        addToQueue: (item: typeof track) => queued.push(item.id),
        playNext: () => undefined,
    }),
    useAudioState: () => ({ currentTrack: null }),
});
mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: () => undefined }) },
});
mock.module("@/lib/api", {
    namedExports: { api: { addTrackToPlaylist: async () => undefined } },
});
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: { useOptionalDeviceOffline: () => null },
});
mock.module("@/components/ui/ShareLinkModal", {
    namedExports: { ShareLinkModal: () => null },
});

let anchor = {
    left: 318,
    top: 120,
    right: 362,
    bottom: 164,
    width: 44,
    height: 44,
};
const originalBounds = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
    queued.length = 0;
    Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: undefined,
    });
    anchor = {
        left: 318,
        top: 120,
        right: 362,
        bottom: 164,
        width: 44,
        height: 44,
    };
    Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 390,
    });
    Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 844,
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.getAttribute("aria-haspopup") === "menu")
            return {
                ...anchor,
                x: anchor.left,
                y: anchor.top,
                toJSON: () => ({}),
            };
        if (this.getAttribute("role") === "menu")
            return {
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: 260,
                bottom: 484,
                width: 260,
                height: 484,
                toJSON: () => ({}),
            };
        return originalBounds.call(this);
    };
});
after(() => {
    HTMLElement.prototype.getBoundingClientRect = originalBounds;
    GlobalRegistrator.unregister();
});

async function pointerClick(button: HTMLElement) {
    await React.act(async () =>
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    await React.act(async () =>
        button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })),
    );
    await React.act(async () => button.click());
}

async function renderMenu(t: {
    after: (cleanup: () => Promise<void>) => void;
}) {
    const { TrackOverflowMenu } =
        await import("../../components/ui/TrackOverflowMenu");
    const { MusicDetailTrackSurface } =
        await import("../../components/music-detail/MusicDetailTrackSurface");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let rowPlays = 0;
    await React.act(async () =>
        root.render(
            React.createElement(
                MusicDetailTrackSurface,
                { label: "Любимое" },
                React.createElement(
                    "div",
                    { onClick: () => rowPlays++ },
                    React.createElement(TrackOverflowMenu, { track }),
                ),
            ),
        ),
    );
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });
    const trigger = container.querySelector<HTMLButtonElement>(
        '[aria-haspopup="menu"]',
    )!;
    await pointerClick(trigger);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    assert.ok(menu);
    return { container, menu, trigger, rowPlays: () => rowPlays };
}

test("a single liked-track popup escapes the clipped track surface and its items remain clickable", async (t) => {
    const view = await renderMenu(t);
    assert.ok(
        view.menu.closest('[data-music-detail="tracks"]') === null,
        "popup must escape the clipping surface",
    );
    const queue = [
        ...view.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes("Добавить в очередь"))!;
    await pointerClick(queue);
    assert.deepEqual(queued, ["only-track"]);
    assert.equal(view.rowPlays(), 0);
    assert.ok(document.querySelector('[role="menu"]') === null);
});

test("the popup aligns with the trigger while staying inside a narrow viewport", async (t) => {
    const { menu } = await renderMenu(t);
    assert.equal(Number.parseFloat(menu.style.left), 102);
    assert.equal(Number.parseFloat(menu.style.top), 168);
    assert.equal(Number.parseFloat(menu.style.maxWidth), 374);
});

test("a last-row popup flips upward and becomes scrollable on a short narrow screen", async (t) => {
    Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 200,
    });
    Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 260,
    });
    anchor = {
        left: 140,
        top: 176,
        right: 184,
        bottom: 220,
        width: 44,
        height: 44,
    };
    const { menu } = await renderMenu(t);
    assert.equal(Number.parseFloat(menu.style.left), 8);
    assert.equal(Number.parseFloat(menu.style.top), 8);
    assert.equal(Number.parseFloat(menu.style.maxHeight), 164);
    assert.equal(Number.parseFloat(menu.style.maxWidth), 184);
});

test("pinch zoom also caps the minimum menu width to the visual viewport", async (t) => {
    Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: Object.assign(new EventTarget(), {
            width: 180,
            height: 300,
            offsetLeft: 0,
            offsetTop: 0,
        }),
    });
    const { menu } = await renderMenu(t);
    assert.equal(Number.parseFloat(menu.style.maxWidth), 164);
    assert.equal(Number.parseFloat(menu.style.minWidth), 164);
});

test("scrolling inside the popup preserves it, scrolling its list dismisses it", async (t) => {
    const { menu, container, trigger } = await renderMenu(t);
    await React.act(async () => menu.dispatchEvent(new Event("scroll")));
    assert.ok(document.querySelector('[role="menu"]'));
    await React.act(async () => container.dispatchEvent(new Event("scroll")));
    assert.ok(document.querySelector('[role="menu"]') === null);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await pointerClick(trigger);
    await React.act(async () => window.dispatchEvent(new Event("scroll")));
    assert.ok(document.querySelector('[role="menu"]') === null);
});

test("Escape, outside pointer clicks, and resize dismiss the anchored popup", async (t) => {
    const { trigger } = await renderMenu(t);
    await React.act(async () =>
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    assert.ok(document.querySelector('[role="menu"]') === null);
    await pointerClick(trigger);
    await pointerClick(document.body);
    assert.ok(document.querySelector('[role="menu"]') === null);
    await pointerClick(trigger);
    await React.act(async () => window.dispatchEvent(new Event("resize")));
    assert.ok(document.querySelector('[role="menu"]') === null);
});
