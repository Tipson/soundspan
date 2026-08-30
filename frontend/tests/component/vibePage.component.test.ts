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
    vibeEmbeddings: true,
    audioAnalysis: true,
    personalizedEnabled: false,
    personalizedMode: "for-you",
    playedTrackIds: [] as string[],
    playedAsVibeQueue: false,
    vibeModeEnabled: false,
    waveMode: "for-you",
    vibeQueueIds: [] as string[],
    upcomingTrackIds: [] as string[],
    upcomingQueueCalls: [] as string[][],
    upcomingPreservesOrder: false,
    advanceOrigins: [] as string[],
    currentTrack: null as null | { id: string; title: string },
    personalizedFeed: createPersonalizedFeed(),
};

function createPersonalizedFeed() {
    return {
        shelves: {
            quickPicks: [
                {
                    id: "yt:radio-1",
                    title: "Quick Pick",
                },
                {
                    id: "yt:shared-1",
                    title: "Shared Pick",
                },
            ],
            listenAgain: [
                {
                    id: "yt:familiar-1",
                    title: "Familiar Track",
                },
            ],
            discovery: [
                {
                    id: "yt:discovery-1",
                    title: "Discovery Track",
                },
                {
                    id: "yt:shared-1",
                    title: "Shared Pick",
                },
            ],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
}

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
        Check: Icon,
        Map: Icon,
        Heart: Icon,
        History: Icon,
        ListMusic: Icon,
        SkipForward: Icon,
        ThumbsDown: Icon,
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
            vibeEmbeddings: state.vibeEmbeddings,
            audioAnalysis: state.audioAnalysis,
            loading: false,
        }),
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioControls: () => ({ playTracks: async () => undefined }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: async (
                tracks: Array<{ id: string }>,
                _startIndex?: number,
                isVibeQueue?: boolean,
            ) => {
                state.playedTrackIds = tracks.map((track) => track.id);
                state.playedAsVibeQueue = isVibeQueue === true;
            },
            advanceQueue: (origin: string) => state.advanceOrigins.push(origin),
            setUpcoming: (
                tracks: Array<{ id: string }>,
                preserveOrder?: boolean,
            ) => {
                state.upcomingTrackIds = tracks.map((track) => track.id);
                state.upcomingQueueCalls.push(state.upcomingTrackIds);
                state.upcomingPreservesOrder = preserveOrder === true;
            },
        }),
    },
});

mock.module("@/lib/audio/providerRadioContinuation", {
    namedExports: {
        toProviderPlaybackTrack: (track: { id: string }) => track,
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            setVibeMode: (enabled: boolean) => {
                state.vibeModeEnabled = enabled;
            },
            setWaveMode: (mode: string) => {
                state.waveMode = mode;
            },
            setVibeSourceFeatures: () => undefined,
            setVibeQueueIds: (ids: string[]) => {
                state.vibeQueueIds = ids;
            },
            currentTrack: state.currentTrack,
            vibeMode: state.vibeModeEnabled,
        }),
    },
});

mock.module("@/components/vibe/NowPlayingConnected", {
    namedExports: {
        NowPlayingConnected: ({
            track,
        }: {
            track: null | { title: string };
        }) =>
            track
                ? React.createElement(
                      "div",
                      { "data-testid": "wave-now-playing" },
                      track.title,
                  )
                : null,
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
        usePersonalizedHomeFeed: (
            _limit: number,
            enabled: boolean,
            mode: string,
        ) => {
            state.personalizedEnabled = enabled;
            state.personalizedMode = mode;
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
    state.vibeEmbeddings = true;
    state.audioAnalysis = true;
    state.personalizedEnabled = false;
    state.personalizedMode = "for-you";
    state.playedTrackIds = [];
    state.playedAsVibeQueue = false;
    state.vibeModeEnabled = false;
    state.waveMode = "for-you";
    state.vibeQueueIds = [];
    state.upcomingTrackIds = [];
    state.upcomingQueueCalls = [];
    state.upcomingPreservesOrder = false;
    state.advanceOrigins = [];
    state.currentTrack = null;
    state.personalizedFeed = createPersonalizedFeed();
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

function findButtonByLabel(
    container: HTMLElement,
    label: string,
): HTMLButtonElement | null {
    return (
        Array.from(container.querySelectorAll("button")).find(
            (button) => button.getAttribute("aria-label") === label,
        ) ?? null
    );
}

test("Vibe replaces an unusable analysis surface with a plain-language My Wave landing", async () => {
    state.embeddedTracks = 1;
    const mounted = await mountPage();

    assert.match(mounted.container.textContent ?? "", /My Wave/);
    assert.match(
        mounted.container.textContent ?? "",
        /likes, dislikes, and skips/i,
    );
    assert.match(mounted.container.textContent ?? "", /keeps playing/i);
    assert.doesNotMatch(mounted.container.textContent ?? "", /tracks ready/i);
    assert.doesNotMatch(
        mounted.container.textContent ?? "",
        /provider|audio[- ]dna|local(?:ly)? (?:files|stored|analyzed)/i,
    );
    assert.equal(state.personalizedEnabled, true);
    assert.equal(findButton(mounted.container, "Map"), null);
    assert.equal(
        mounted.container.querySelector('[data-testid="vibe-map"]'),
        null,
    );

    await unmountPage(mounted);
});

test("My Wave presents one immersive continuous-radio stage without a finite queue count", async () => {
    const mounted = await mountPage();

    const surface = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-surface"]',
    );
    const signalDial = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-signal-dial"]',
    );
    const directionCard = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-direction-card"]',
    );
    const heading = mounted.container.querySelector("h1");

    assert.ok(surface);
    assert.equal(surface.getAttribute("aria-labelledby"), "wave-title");
    assert.ok(signalDial);
    assert.ok(directionCard);
    assert.equal(heading?.id, "wave-title");
    assert.equal(heading?.textContent?.trim(), "My Wave");
    assert.match(
        mounted.container.textContent ?? "",
        /starts with a few picks, then keeps finding what comes next/i,
    );
    assert.doesNotMatch(
        mounted.container.textContent ?? "",
        /\b\d+\s+(?:tracks?|songs?)\s+(?:ready|queued)\b/i,
    );
    assert.doesNotMatch(directionCard.className, /\btruncate\b/);

    const playWave = findButton(mounted.container, "Play My Wave");
    assert.ok(playWave);
    assert.match(playWave.className, /min-h-36/);
    assert.match(playWave.className, /min-w-36/);

    await unmountPage(mounted);
});

test("My Wave remains the primary Vibe page when local audio analysis is disabled", async () => {
    state.vibeEmbeddings = false;
    state.audioAnalysis = false;
    const mounted = await mountPage();

    assert.match(mounted.container.textContent ?? "", /My Wave/);
    assert.match(
        mounted.container.textContent ?? "",
        /likes, dislikes, and skips/i,
    );
    assert.doesNotMatch(
        mounted.container.textContent ?? "",
        /Feature not available|DCLAP/i,
    );
    assert.equal(state.personalizedEnabled, true);

    await unmountPage(mounted);
});

test("Tune My Wave stages a supported direction before applying it", async () => {
    const mounted = await mountPage();
    const tune = findButton(mounted.container, "Tune");

    assert.ok(tune);
    assert.equal(mounted.container.querySelector('[role="dialog"]'), null);

    await React.act(async () => tune.click());

    const dialog = mounted.container.querySelector<HTMLElement>(
        '[role="dialog"][aria-labelledby="wave-direction-title"]',
    );
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /Tune My Wave/);

    const newToMe = findButtonByLabel(dialog, "New to me");
    const familiar = findButtonByLabel(dialog, "Familiar");
    const directionOptions = dialog.querySelectorAll('[role="radio"]');

    assert.ok(newToMe);
    assert.ok(familiar);
    assert.equal(directionOptions.length, 3);
    assert.match(
        dialog.textContent ?? "",
        /how close the next picks stay to your listening history/i,
    );
    assert.match(dialog.textContent ?? "", /Your mix/i);
    assert.match(dialog.textContent ?? "", /Open up/i);
    assert.match(dialog.textContent ?? "", /Stay close/i);
    assert.equal(newToMe.getAttribute("role"), "radio");
    assert.equal(newToMe.getAttribute("aria-checked"), "false");
    for (const option of directionOptions) {
        assert.doesNotMatch((option as HTMLElement).className, /\btruncate\b/);
    }

    await React.act(async () => newToMe.click());
    assert.equal(newToMe.getAttribute("aria-checked"), "true");
    assert.equal(state.personalizedMode, "for-you");

    const applyNew = findButton(dialog, "Use New to me");
    assert.ok(applyNew);
    await React.act(async () => applyNew.click());
    assert.equal(state.personalizedMode, "new");
    assert.deepEqual(state.upcomingQueueCalls, []);
    assert.equal(mounted.container.querySelector('[role="dialog"]'), null);

    const reopenTune = findButton(mounted.container, "Tune");
    assert.ok(reopenTune);
    await React.act(async () => reopenTune.click());

    const reopenedDialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(reopenedDialog);
    const reopenedFamiliar = findButtonByLabel(reopenedDialog, "Familiar");
    assert.ok(reopenedFamiliar);
    await React.act(async () => reopenedFamiliar.click());

    const applyFamiliar = findButton(reopenedDialog, "Use Familiar");
    assert.ok(applyFamiliar);
    await React.act(async () => applyFamiliar.click());
    assert.equal(state.personalizedMode, "familiar");

    const playWave = findButton(mounted.container, "Play My Wave");
    assert.ok(playWave);
    await React.act(async () => playWave.click());
    assert.deepEqual(state.playedTrackIds, ["yt:familiar-1"]);
    assert.equal(state.playedAsVibeQueue, true);
    assert.equal(state.vibeModeEnabled, true);
    assert.equal(state.waveMode, "familiar");
    assert.deepEqual(state.vibeQueueIds, ["yt:familiar-1"]);

    await unmountPage(mounted);
});

test("Tune after Play replaces the upcoming Wave queue with the new direction", async () => {
    const mounted = await mountPage();
    const playWave = findButton(mounted.container, "Play My Wave");
    assert.ok(playWave);

    await React.act(async () => playWave.click());
    state.currentTrack = {
        id: "yt:discovery-1",
        title: "Discovery Track",
    };

    const tune = findButton(mounted.container, "Tune");
    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const newToMe = findButtonByLabel(dialog, "New to me");
    assert.ok(newToMe);
    await React.act(async () => newToMe.click());

    const applyNew = findButton(dialog, "Use New to me");
    assert.ok(applyNew);
    await React.act(async () => {
        applyNew.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(state.waveMode, "new");
    assert.deepEqual(state.upcomingTrackIds, ["yt:shared-1"]);
    assert.deepEqual(state.upcomingQueueCalls, [["yt:shared-1"]]);
    assert.equal(state.upcomingPreservesOrder, true);
    assert.deepEqual(state.vibeQueueIds, ["yt:discovery-1", "yt:shared-1"]);

    await unmountPage(mounted);
});

test("Tune My Wave closes on Escape without applying a draft direction", async () => {
    const mounted = await mountPage();
    const tune = findButton(mounted.container, "Tune");
    assert.ok(tune);

    await React.act(async () => tune.click());
    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);

    const newToMe = findButtonByLabel(dialog, "New to me");
    assert.ok(newToMe);
    await React.act(async () => newToMe.click());
    assert.equal(state.personalizedMode, "for-you");

    await React.act(async () => {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });

    assert.equal(mounted.container.querySelector('[role="dialog"]'), null);
    assert.equal(state.personalizedMode, "for-you");

    await unmountPage(mounted);
});

test("Tune My Wave supports arrow-key radio navigation", async () => {
    const mounted = await mountPage();
    const tune = findButton(mounted.container, "Tune");
    assert.ok(tune);

    await React.act(async () => tune.click());
    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);

    const forYou = findButtonByLabel(dialog, "For you");
    const newToMe = findButtonByLabel(dialog, "New to me");
    assert.ok(forYou);
    assert.ok(newToMe);
    forYou.focus();

    await React.act(async () => {
        forYou.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "ArrowDown",
                bubbles: true,
            }),
        );
    });

    assert.equal(newToMe.getAttribute("aria-checked"), "true");
    assert.equal(document.activeElement, newToMe);
    assert.equal(state.personalizedMode, "for-you");

    await unmountPage(mounted);
});

test("My Wave exposes connected like and dislike controls for the current track", async () => {
    state.currentTrack = { id: "yt:playing-1", title: "Playing Track" };
    const mounted = await mountPage();

    assert.match(mounted.container.textContent ?? "", /Now playing/i);
    const inlineNowPlaying = mounted.container.querySelector<HTMLElement>(
        '[aria-labelledby="wave-now-playing-title"]',
    );
    assert.ok(inlineNowPlaying);
    assert.match(inlineNowPlaying.className, /(?:^|\s)hidden(?:\s|$)/);
    assert.match(
        inlineNowPlaying.className,
        /(?:^|\s)min-\[1025px\]:block(?:\s|$)/,
    );
    assert.equal(
        mounted.container.querySelector('[data-testid="wave-now-playing"]')
            ?.textContent,
        "Playing Track",
    );
    const skip = findButton(mounted.container, "Skip");
    assert.ok(skip);
    await React.act(async () => skip.click());
    assert.deepEqual(state.advanceOrigins, ["manual"]);

    await unmountPage(mounted);
});

test("Familiar mode falls back to quick picks when listening history is empty", async () => {
    state.personalizedFeed.shelves.listenAgain = [];
    const mounted = await mountPage();
    const tune = findButton(mounted.container, "Tune");

    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const familiar = findButtonByLabel(dialog, "Familiar");

    assert.ok(familiar);
    await React.act(async () => familiar.click());
    const applyFamiliar = findButton(dialog, "Use Familiar");
    assert.ok(applyFamiliar);
    await React.act(async () => applyFamiliar.click());
    const playWave = findButton(mounted.container, "Play My Wave");
    assert.ok(playWave);
    await React.act(async () => playWave.click());
    assert.deepEqual(state.playedTrackIds, ["yt:radio-1", "yt:shared-1"]);

    await unmountPage(mounted);
});

test("Vibe still offers My Wave when the unrelated local-track list fails", async () => {
    state.embeddedTracks = 1;
    state.tracksFail = true;
    const mounted = await mountPage();

    assert.ok(findButton(mounted.container, "Play My Wave"));
    assert.equal(state.personalizedEnabled, true);

    await unmountPage(mounted);
});

test("Vibe falls back to My Wave when analysis status is unavailable", async () => {
    state.statusFail = true;
    const mounted = await mountPage();

    assert.match(mounted.container.textContent ?? "", /My Wave/);
    assert.match(mounted.container.textContent ?? "", /listening/i);
    assert.ok(findButton(mounted.container, "Play My Wave"));
    assert.equal(state.personalizedEnabled, true);

    await unmountPage(mounted);
});

for (const embeddedTracks of [2, 4, 5]) {
    test(`Vibe stays online-first with ${embeddedTracks} legacy local embeddings`, async () => {
        state.embeddedTracks = embeddedTracks;
        const mounted = await mountPage();

        assert.match(mounted.container.textContent ?? "", /My Wave/);
        assert.doesNotMatch(
            mounted.container.textContent ?? "",
            /Audio DNA|locally analyzed files|audio fingerprints/,
        );
        assert.ok(findButton(mounted.container, "Play My Wave"));
        assert.equal(state.personalizedEnabled, true);
        assert.equal(findButton(mounted.container, "Map"), null);
        assert.equal(
            mounted.container.querySelector('[data-testid="vibe-map"]'),
            null,
        );

        await unmountPage(mounted);
    });
}
