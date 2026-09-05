import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalMatchMedia = window.matchMedia;
const scrollTargets: string[] = [];
const scrollBehaviors: Array<ScrollBehavior | undefined> = [];
let reducedMotion = false;
const keyboardCalls = {
    resume: 0,
    pause: 0,
    volumes: [] as number[],
};

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            playbackType: "track",
            currentTrack: { id: "track-1" },
            currentAudiobook: null,
            currentPodcast: null,
        }),
        useAudioVolumeMode: () => ({ volume: 0.5 }),
        usePlaybackStatus: () => ({ isPlaying: false }),
        useAudioControls: () => ({
            resume: () => {
                keyboardCalls.resume += 1;
            },
            pause: () => {
                keyboardCalls.pause += 1;
            },
            next: () => undefined,
            previous: () => undefined,
            skipForward: () => undefined,
            skipBackward: () => undefined,
            setVolume: (volume: number) => keyboardCalls.volumes.push(volume),
            toggleMute: () => undefined,
            toggleShuffle: () => undefined,
        }),
    },
});

mock.module("@/lib/tv-utils", {
    namedExports: { useIsTV: () => false },
});

HTMLElement.prototype.scrollIntoView = function scrollIntoView(
    options?: boolean | ScrollIntoViewOptions,
) {
    scrollTargets.push(this.textContent ?? "");
    scrollBehaviors.push(
        typeof options === "object" ? options.behavior : undefined,
    );
};

window.matchMedia = ((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
})) as typeof window.matchMedia;

after(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    window.matchMedia = originalMatchMedia;
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

beforeEach(() => {
    keyboardCalls.resume = 0;
    keyboardCalls.pause = 0;
    keyboardCalls.volumes.length = 0;
    reducedMotion = false;
    scrollBehaviors.length = 0;
});

const SYNCED_LYRICS = [
    "[00:01.00]Первая строка",
    "[00:02.00]Вторая строка",
    "[00:03.00]",
].join("\n");

async function mountLyrics(overrides: Record<string, unknown> = {}) {
    const { createRoot } = await import("react-dom/client");
    const { SyncedLyrics } =
        await import("../../components/player/SyncedLyrics");
    const { useKeyboardShortcuts } =
        await import("../../hooks/useKeyboardShortcuts");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
        syncedLyrics: SYNCED_LYRICS,
        currentTime: 1,
        isPlaying: true,
        onSeek: () => undefined,
        ...overrides,
    };
    function Fixture() {
        useKeyboardShortcuts();
        return React.createElement(SyncedLyrics, props);
    }

    async function render(nextOverrides: Record<string, unknown> = {}) {
        Object.assign(props, nextOverrides);
        await React.act(async () => {
            root.render(React.createElement(Fixture));
        });
    }

    await render();
    return {
        container,
        render,
        async close() {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("timestamped lyric lines are native keyboard-accessible seek controls", async () => {
    const seekCalls: number[] = [];
    const view = await mountLyrics({
        onSeek: (seconds: number) => seekCalls.push(seconds),
    });

    try {
        const controls = Array.from(view.container.querySelectorAll("button"));
        assert.deepEqual(
            controls.map((control) => control.textContent),
            ["Первая строка", "Вторая строка"],
            "non-empty timestamped lines should use native button semantics",
        );
        assert.equal(controls[0].type, "button");
        assert.equal(controls[0].tabIndex, 0);
        assert.equal(controls[0].getAttribute("aria-current"), "true");
        assert.equal(controls[1].hasAttribute("aria-current"), false);

        controls[1].focus();
        controls[1].click();
        assert.equal(document.activeElement, controls[1]);
        assert.deepEqual(seekCalls, [2]);

        const blankLine = Array.from(
            view.container.querySelectorAll("div"),
        ).find((node) => node.textContent === "\u00a0");
        assert.ok(blankLine, "blank timing lines should remain layout spacers");
    } finally {
        await view.close();
    }
});

test("Space and Enter on a lyric seek without triggering global playback", async () => {
    const seekCalls: number[] = [];
    const view = await mountLyrics({
        onSeek: (seconds: number) => seekCalls.push(seconds),
    });

    try {
        const control = view.container.querySelectorAll("button")[1];
        assert.ok(control);
        control.focus();

        for (const key of [" ", "Enter"]) {
            await React.act(async () => {
                const keydown = new KeyboardEvent("keydown", {
                    key,
                    bubbles: true,
                    cancelable: true,
                });
                control.dispatchEvent(keydown);
                control.dispatchEvent(
                    new KeyboardEvent("keyup", { key, bubbles: true }),
                );
                // Happy DOM does not synthesize native button activation.
                if (!keydown.defaultPrevented) control.click();
            });
        }

        assert.deepEqual(seekCalls, [2, 2]);
        assert.equal(keyboardCalls.resume, 0);
        assert.equal(keyboardCalls.pause, 0);
    } finally {
        await view.close();
    }
});

test("vertical lyrics navigation does not change global playback volume", async () => {
    const view = await mountLyrics();

    try {
        const viewport = view.container.firstElementChild as HTMLElement;
        viewport.focus();
        for (const key of ["ArrowUp", "ArrowDown"]) {
            await React.act(async () => {
                viewport.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        key,
                        bubbles: true,
                        cancelable: true,
                    }),
                );
            });
        }
        assert.deepEqual(keyboardCalls.volumes, []);
    } finally {
        await view.close();
    }
});

test("timestamped lines without a seek callback stay non-interactive", async () => {
    const view = await mountLyrics({ onSeek: undefined });

    try {
        assert.equal(view.container.querySelectorAll("button").length, 0);
        assert.match(view.container.textContent ?? "", /Первая строка/);
        assert.match(view.container.textContent ?? "", /Вторая строка/);
    } finally {
        await view.close();
    }
});

test("automatic lyric following honors reduced-motion preference", async () => {
    reducedMotion = true;
    scrollTargets.length = 0;
    const view = await mountLyrics();

    try {
        assert.deepEqual(scrollTargets, ["Первая строка"]);
        assert.deepEqual(scrollBehaviors, ["auto"]);
    } finally {
        await view.close();
    }
});

for (const intent of ["wheel", "touchmove", "keydown"] as const) {
    test(`manual ${intent} lyrics browsing pauses recentering until inactivity`, async () => {
        scrollTargets.length = 0;
        const view = await mountLyrics();
        const originalSetTimeout = globalThis.setTimeout;
        const originalClearTimeout = globalThis.clearTimeout;
        let resumeAutoScroll: (() => void) | undefined;

        try {
            assert.deepEqual(scrollTargets, ["Первая строка"]);
            globalThis.setTimeout = ((callback: TimerHandler) => {
                assert.equal(typeof callback, "function");
                resumeAutoScroll = callback as () => void;
                return 1 as unknown as ReturnType<typeof setTimeout>;
            }) as unknown as typeof setTimeout;
            globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;

            const viewport = view.container.firstElementChild as HTMLElement;
            assert.equal(viewport.getAttribute("role"), "region");
            assert.equal(viewport.getAttribute("aria-label"), "Текст");
            assert.equal(viewport.tabIndex, 0);
            await React.act(async () => {
                viewport.dispatchEvent(
                    intent === "keydown"
                        ? new KeyboardEvent(intent, {
                              bubbles: true,
                              key: "PageDown",
                          })
                        : new Event(intent, { bubbles: true }),
                );
            });
            await view.render({ currentTime: 2 });
            assert.deepEqual(
                scrollTargets,
                ["Первая строка"],
                "playback progress must not override active manual browsing",
            );

            assert.ok(resumeAutoScroll, "expected a bounded resume timer");
            await React.act(async () => resumeAutoScroll?.());
            assert.deepEqual(scrollTargets, ["Первая строка", "Вторая строка"]);
        } finally {
            await view.close();
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        }
    });
}
