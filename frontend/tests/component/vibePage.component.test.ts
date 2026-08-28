import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
    embeddedTracks: 1,
    statusFail: false,
    tracksFail: false,
    personalizedEnabled: false,
    personalizedFeed: {
        shelves: {
            quickPicks: [
                {
                    id: "yt:radio-1",
                    title: "Provider Radio Track",
                },
            ],
            listenAgain: [],
            discovery: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    },
};

const Icon = () => React.createElement("i");
const MotionDiv = ({
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
}) => React.createElement("div", props, children);

mock.module("framer-motion", {
    namedExports: {
        motion: { div: MotionDiv },
        AnimatePresence: ({ children }: { children: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
    },
});

mock.module("lucide-react", {
    namedExports: {
        Loader2: Icon,
        RefreshCw: Icon,
        AlertCircle: Icon,
        Disc3: Icon,
        Play: Icon,
        Search: Icon,
        Shuffle: Icon,
        X: Icon,
        AudioWaveform: Icon,
        Map: Icon,
    },
});

mock.module("next/image", {
    defaultExport: ({ alt }: { alt: string }) =>
        React.createElement("span", { "aria-label": alt }),
});

mock.module("next/link", {
    defaultExport: ({
        children,
        href,
    }: {
        children: React.ReactNode;
        href: string;
    }) => React.createElement("a", { href }, children),
});

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({
            vibeEmbeddings: true,
            audioAnalysis: true,
            loading: false,
        }),
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioControls: () => ({ playTracks: async () => undefined }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            setVibeMode: () => undefined,
            setVibeSourceFeatures: () => undefined,
            setVibeQueueIds: () => undefined,
            currentTrack: null,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getVibeStatus: async () => {
                if (state.statusFail) throw new Error("vibe unavailable");
                return {
                    totalTracks: state.embeddedTracks,
                    embeddedTracks: state.embeddedTracks,
                };
            },
            getTracks: async () => {
                if (state.tracksFail) throw new Error("library unavailable");
                return { tracks: [] };
            },
            getCoverArtUrl: (url: string) => url,
        },
        vibeErrorMessage: (_error: unknown, fallback: string) => fallback,
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: { error: () => undefined },
    },
});

mock.module("@/features/home/hooks/usePersonalizedHomeFeed", {
    namedExports: {
        usePersonalizedHomeFeed: (_limit: number, enabled: boolean) => {
            state.personalizedEnabled = enabled;
            return {
                data: state.personalizedFeed,
                isLoading: false,
                isError: false,
            };
        },
    },
});

mock.module("@/features/home/components/PersonalizedTrackShelf", {
    namedExports: {
        PersonalizedTrackShelf: ({
            title,
            tracks,
        }: {
            title: string;
            tracks: Array<{ title: string }>;
        }) =>
            React.createElement(
                "section",
                { "data-testid": "provider-radio" },
                `${title}:${tracks.map((track) => track.title).join(",")}`,
            ),
    },
});

mock.module("@/components/vibe/VibeMapTab", {
    namedExports: {
        VibeMapTab: () =>
            React.createElement("div", { "data-testid": "vibe-map" }),
    },
});

after(() => {
    GlobalRegistrator.unregister();
});

beforeEach(() => {
    state.embeddedTracks = 1;
    state.statusFail = false;
    state.tracksFail = false;
    state.personalizedEnabled = false;
    window.localStorage.clear();
});

interface MountedPage {
    container: HTMLDivElement;
    root: Root;
}

async function mountPage(): Promise<MountedPage> {
    const VibePage = (await import("../../app/vibe/page")).default;
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(VibePage));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    return { container, root };
}

async function unmountPage({ container, root }: MountedPage): Promise<void> {
    await React.act(async () => root.unmount());
    container.remove();
}

function findButton(
    container: HTMLElement,
    label: string,
): HTMLButtonElement | null {
    return (
        Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === label,
        ) ?? null
    );
}

test("Vibe replaces an unusable audio-DNA surface with provider radio below two local embeddings", async () => {
    state.embeddedTracks = 1;
    const mounted = await mountPage();

    assert.match(
        mounted.container.textContent ?? "",
        /Radio while Vibe warms up/,
    );
    assert.match(
        mounted.container.textContent ?? "",
        /Audio-DNA Vibe needs at least two locally stored, analyzed files/,
    );
    assert.match(
        mounted.container.textContent ?? "",
        /Provider radio:Provider Radio Track/,
    );
    assert.equal(state.personalizedEnabled, true);
    assert.equal(findButton(mounted.container, "Map"), null);
    assert.equal(
        mounted.container.querySelector('[data-testid="vibe-map"]'),
        null,
    );

    await unmountPage(mounted);
});

test("Vibe still offers provider radio when the unrelated local-track list fails", async () => {
    state.embeddedTracks = 1;
    state.tracksFail = true;
    const mounted = await mountPage();

    assert.match(
        mounted.container.textContent ?? "",
        /Provider radio:Provider Radio Track/,
    );
    assert.equal(state.personalizedEnabled, true);

    await unmountPage(mounted);
});

test("Vibe falls back to provider radio when Audio-DNA status is unavailable", async () => {
    state.statusFail = true;
    const mounted = await mountPage();

    assert.match(
        mounted.container.textContent ?? "",
        /Radio while Vibe warms up/,
    );
    assert.match(
        mounted.container.textContent ?? "",
        /Audio-DNA status is temporarily unavailable/,
    );
    assert.match(
        mounted.container.textContent ?? "",
        /Provider radio:Provider Radio Track/,
    );
    assert.equal(state.personalizedEnabled, true);

    await unmountPage(mounted);
});

for (const embeddedTracks of [2, 4]) {
    test(`Vibe keeps limited exploration but withholds the full map at ${embeddedTracks} local embeddings`, async () => {
        state.embeddedTracks = embeddedTracks;
        const mounted = await mountPage();

        assert.match(mounted.container.textContent ?? "", /Limited Audio DNA/);
        assert.match(
            mounted.container.textContent ?? "",
            /The full Vibe map needs at least 5 locally analyzed files/,
        );
        assert.equal(
            mounted.container.querySelector('[data-testid="provider-radio"]'),
            null,
        );
        assert.equal(state.personalizedEnabled, false);
        assert.equal(findButton(mounted.container, "Map"), null);

        await unmountPage(mounted);
    });
}

test("Vibe preserves the working full map from five local embeddings", async () => {
    state.embeddedTracks = 5;
    const mounted = await mountPage();

    assert.doesNotMatch(
        mounted.container.textContent ?? "",
        /Limited Audio DNA/,
    );
    assert.equal(
        mounted.container.querySelector('[data-testid="provider-radio"]'),
        null,
    );
    assert.equal(state.personalizedEnabled, false);
    const mapButton = findButton(mounted.container, "Map");
    assert.ok(mapButton);

    await React.act(async () => mapButton.click());
    assert.ok(mounted.container.querySelector('[data-testid="vibe-map"]'));

    await unmountPage(mounted);
});
