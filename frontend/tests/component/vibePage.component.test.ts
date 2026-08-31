import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register({ url: "https://soundspan.test/vibe" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
    userId: "user-1",
    embeddedTracks: 1,
    statusFail: false,
    tracksFail: false,
    vibeEmbeddings: true,
    audioAnalysis: true,
    personalizedEnabled: false,
    personalizedMode: "for-you",
    personalizedMood: null as string | null,
    listenTogetherActive: false,
    playedTrackIds: [] as string[],
    playedAsVibeQueue: false,
    isShuffle: true,
    shuffleIndices: [2, 1, 0] as number[],
    vibeModeEnabled: false,
    waveMode: "for-you",
    waveMood: null as string | null,
    vibeQueueIds: [] as string[],
    upcomingTrackIds: [] as string[],
    upcomingQueueCalls: [] as string[][],
    upcomingPreservesOrder: false,
    advanceOrigins: [] as string[],
    isPlaying: false,
    pauseCount: 0,
    playCount: 0,
    currentTrack: null as null | { id: string; title: string },
    personalizedFeed: createPersonalizedFeed(),
    personalizedFeedResolver: null as
        | null
        | ((
              mode: string,
              mood: string | null,
          ) => ReturnType<typeof createPersonalizedFeed>),
    personalizedFeedError: false,
    refetchCalls: 0,
    refetchRecoversError: false,
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
        RotateCcw: Icon,
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
        Pause: Icon,
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

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: true,
            isLoading: false,
            user: { id: state.userId, username: state.userId },
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
            pause: () => {
                state.pauseCount += 1;
            },
            play: () => {
                state.playCount += 1;
            },
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

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        usePlaybackStatus: () => ({ isPlaying: state.isPlaying }),
    },
});

mock.module("@/lib/audio/providerRadioContinuation", {
    namedExports: {
        toProviderPlaybackTrack: (track: { id: string }) => track,
    },
});

mock.module("@/lib/listen-together-session", {
    namedExports: {
        isListenTogetherActiveOrPending: () => state.listenTogetherActive,
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            setIsShuffle: (enabled: boolean) => {
                state.isShuffle = enabled;
            },
            setShuffleIndices: (indices: number[]) => {
                state.shuffleIndices = indices;
            },
            setVibeMode: (enabled: boolean) => {
                state.vibeModeEnabled = enabled;
            },
            setWaveMode: (mode: string) => {
                state.waveMode = mode;
            },
            setWaveMood: (mood: string | null) => {
                state.waveMood = mood;
            },
            setVibeSourceFeatures: () => undefined,
            setVibeQueueIds: (ids: string[]) => {
                state.vibeQueueIds = ids;
            },
            currentTrack: state.currentTrack,
            vibeMode: state.vibeModeEnabled,
            waveMode: state.waveMode,
            waveMood: state.waveMood,
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
            mood: string | null,
        ) => {
            state.personalizedEnabled = enabled;
            state.personalizedMode = mode;
            state.personalizedMood = mood;
            return {
                data: state.personalizedFeedResolver
                    ? state.personalizedFeedResolver(mode, mood)
                    : state.personalizedFeed,
                isLoading: false,
                isError: state.personalizedFeedError,
                refetch: async () => {
                    state.refetchCalls += 1;
                    if (state.refetchRecoversError) {
                        state.personalizedFeedError = false;
                    }
                },
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
    state.userId = "user-1";
    state.embeddedTracks = 1;
    state.statusFail = false;
    state.tracksFail = false;
    state.vibeEmbeddings = true;
    state.audioAnalysis = true;
    state.personalizedEnabled = false;
    state.personalizedMode = "for-you";
    state.personalizedMood = null;
    state.listenTogetherActive = false;
    state.playedTrackIds = [];
    state.playedAsVibeQueue = false;
    state.isShuffle = true;
    state.shuffleIndices = [2, 1, 0];
    state.vibeModeEnabled = false;
    state.waveMode = "for-you";
    state.waveMood = null;
    state.vibeQueueIds = [];
    state.upcomingTrackIds = [];
    state.upcomingQueueCalls = [];
    state.upcomingPreservesOrder = false;
    state.advanceOrigins = [];
    state.isPlaying = false;
    state.pauseCount = 0;
    state.playCount = 0;
    state.currentTrack = null;
    state.personalizedFeed = createPersonalizedFeed();
    state.personalizedFeedResolver = null;
    state.personalizedFeedError = false;
    state.refetchCalls = 0;
    state.refetchRecoversError = false;
    window.localStorage.clear();
    window.history.replaceState({}, "", "https://soundspan.test/vibe");
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

    assert.match(mounted.container.textContent ?? "", /Моя волна/);
    assert.match(mounted.container.textContent ?? "", /учитывает ваши вкусы/i);
    assert.match(
        mounted.container.textContent ?? "",
        /подстраивается, пока вы слушаете/i,
    );
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
    const ambientField = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-ambient-field"]',
    );
    const currentTuning = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-current-tuning"]',
    );
    const orbitStage = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-orbit-stage"]',
    );
    const continuityStatus = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-continuity-status"]',
    );
    const heading = mounted.container.querySelector("h1");
    const description = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-description"]',
    );

    assert.ok(surface);
    assert.equal(surface.getAttribute("aria-labelledby"), "wave-title");
    assert.ok(ambientField);
    assert.ok(currentTuning);
    assert.ok(orbitStage);
    assert.ok(continuityStatus);
    assert.match(
        continuityStatus.textContent ?? "",
        /подстраивается, пока вы слушаете/i,
    );
    assert.equal(heading?.id, "wave-title");
    assert.equal(heading?.textContent?.trim(), "Моя волна");
    assert.ok(description);
    assert.match(description.className, /line-clamp-2/);
    assert.doesNotMatch(heading?.className ?? "", /6\.6rem/);
    assert.match(mounted.container.textContent ?? "", /продолжится дальше/i);
    assert.doesNotMatch(
        mounted.container.textContent ?? "",
        /\b\d+\s+(?:tracks?|songs?)\s+(?:ready|queued)\b/i,
    );
    assert.doesNotMatch(currentTuning.className, /\btruncate\b/);
    assert.doesNotMatch(mounted.container.textContent ?? "", /\bLive\b|radar/i);

    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);
    assert.equal(playWave.getAttribute("data-testid"), "wave-main-toggle");
    assert.equal(
        mounted.container.querySelectorAll(
            'button[data-testid="wave-main-toggle"]',
        ).length,
        1,
    );
    assert.match(playWave.className, /min-h-20/);
    assert.match(playWave.className, /min-w-20/);

    await unmountPage(mounted);
});

test("My Wave stays bounded to the app viewport while its tune sheet owns overflow", async () => {
    const mounted = await mountPage();

    const page = mounted.container.querySelector<HTMLElement>(
        "main[data-wave-mode]",
    );
    const surface = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-surface"]',
    );
    assert.ok(page);
    assert.ok(surface);

    const pageClasses = new Set(page.className.split(/\s+/));
    const surfaceClasses = new Set(surface.className.split(/\s+/));
    for (const className of ["h-full", "min-h-0", "overflow-hidden"]) {
        assert.equal(
            pageClasses.has(className),
            true,
            `Wave page must include ${className}`,
        );
        assert.equal(
            surfaceClasses.has(className),
            true,
            `Wave surface must include ${className}`,
        );
    }
    assert.match(
        page.className,
        /pb-\[calc\(var\(--app-bottom-nav-height\)\+var\(--safe-area-bottom\)\)\]/,
        "Mobile Wave must end above the fixed bottom navigation",
    );
    assert.equal(
        [...surfaceClasses].some((className) =>
            className.startsWith("min-h-[calc("),
        ),
        false,
        "Wave surface must not grow beyond the shell viewport",
    );

    const compactCore =
        mounted.container.querySelector<HTMLElement>(".wave-density-core");
    assert.ok(compactCore);
    assert.match(compactCore.className, /\bmin-h-0\b/);
    const responsiveStyles = Array.from(
        mounted.container.querySelectorAll("style"),
    )
        .map((style) => style.textContent ?? "")
        .join("\n");
    assert.match(
        responsiveStyles,
        /min-width:\s*1025px[\s\S]*max-height:\s*850px/,
        "Short desktop Vibe must compact without unlocking page overflow",
    );
    assert.match(
        responsiveStyles,
        /max-width:\s*767px[\s\S]*max-height:\s*900px/,
        "Short mobile Vibe must compact inside its fixed app viewport",
    );
    assert.match(
        responsiveStyles,
        /\.wave-density-continuity,\s*\.wave-density-subtitle\s*\{[\s\S]*?display:\s*none\s*!important;/,
        "Short mobile Vibe must yield optional copy to playback controls and preview",
    );
    assert.match(
        responsiveStyles,
        /\.wave-density-next-row:nth-child\(n\s*\+\s*2\)\s*\{[\s\S]*?display:\s*none\s*!important;/,
        "Short mobile Vibe must keep one usable next-track preview above navigation",
    );
    assert.match(
        responsiveStyles,
        /\.wave-density-orbit\s*\{[\s\S]*?width:\s*7\.75rem\s*!important;[\s\S]*?height:\s*7\.75rem\s*!important;/,
        "Short desktop Vibe must retain enough orbit space for a legible primary control",
    );
    assert.match(
        responsiveStyles,
        /\.wave-density-toggle\s*\{[\s\S]*?width:\s*6\.5rem\s*!important;[\s\S]*?height:\s*6\.5rem\s*!important;[\s\S]*?padding-inline:\s*0\.5rem\s*!important;/,
        "Short desktop Vibe must not squeeze the Russian primary label into a tiny circle",
    );

    const mainToggle = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-main-toggle"]',
    );
    const mainToggleLabel = mainToggle?.querySelector("span");
    assert.ok(mainToggleLabel);
    assert.match(mainToggleLabel.className, /\[text-wrap:balance\]/);
    assert.match(mainToggleLabel.className, /leading-\[1\.05\]/);

    const tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-tune-sheet"]',
    );
    assert.ok(dialog);
    const dialogClasses = new Set(dialog.className.split(/\s+/));
    assert.equal(dialogClasses.has("overflow-y-auto"), true);
    assert.equal(
        [...dialogClasses].some((className) => className.startsWith("max-h-[")),
        true,
        "Tune sheet must keep a bounded internal scroll area",
    );

    await unmountPage(mounted);
});

test("the Wave stage previews what comes next without presenting a finite queue", async () => {
    state.currentTrack = { id: "yt:radio-1", title: "Quick Pick" };
    state.vibeModeEnabled = true;
    const mounted = await mountPage();

    const page = mounted.container.querySelector<HTMLElement>(
        "main[data-wave-mode]",
    );
    const preview = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-next-preview"]',
    );
    const nowPlayingPanel = mounted.container.querySelector<HTMLElement>(
        '[data-testid="wave-now-playing-panel"]',
    );
    const skipButton = mounted.container.querySelector<HTMLButtonElement>(
        '[data-testid="wave-skip"]',
    );
    assert.ok(page);
    assert.match(
        page.className,
        /pb-\[calc\(var\(--app-mini-player-height\)\+var\(--app-bottom-nav-height\)\+var\(--safe-area-bottom\)\+4px\)\]/,
        "Active mobile Wave must end above both the mini player and bottom navigation",
    );
    assert.ok(preview);
    assert.ok(nowPlayingPanel);
    assert.ok(skipButton);
    assert.match(
        nowPlayingPanel.parentElement?.parentElement?.className ?? "",
        /\bshrink-0\b/,
        "Active Wave feedback must remain a non-collapsing bottom region",
    );
    assert.match(preview.textContent ?? "", /Далее/i);
    assert.match(preview.textContent ?? "", /Discovery Track|Shared Pick/i);
    assert.doesNotMatch(
        preview.textContent ?? "",
        /\b\d+\s+(?:tracks?|songs?)\b/i,
    );

    await unmountPage(mounted);
});

test("For you keeps recent listens to a rare accent instead of every third track", async () => {
    state.personalizedFeed.shelves.quickPicks = Array.from(
        { length: 5 },
        (_, index) => ({
            id: `yt:quick-${index + 1}`,
            title: `Quick ${index + 1}`,
        }),
    );
    state.personalizedFeed.shelves.discovery = Array.from(
        { length: 5 },
        (_, index) => ({
            id: `yt:discovery-${index + 1}`,
            title: `Discovery ${index + 1}`,
        }),
    );
    state.personalizedFeed.shelves.listenAgain = Array.from(
        { length: 10 },
        (_, index) => ({
            id: `yt:recent-${index + 1}`,
            title: `Recent ${index + 1}`,
        }),
    );
    const mounted = await mountPage();

    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);
    await React.act(async () => playWave.click());

    assert.deepEqual(state.playedTrackIds.slice(0, 6), [
        "yt:quick-1",
        "yt:discovery-1",
        "yt:quick-2",
        "yt:discovery-2",
        "yt:quick-3",
        "yt:recent-1",
    ]);
    assert.deepEqual(
        state.playedTrackIds.filter((id) => id.startsWith("yt:recent-")),
        ["yt:recent-1", "yt:recent-2"],
    );

    await unmountPage(mounted);
});

test("the single primary Wave control pauses active Wave playback", async () => {
    state.currentTrack = { id: "yt:playing-1", title: "Playing Track" };
    state.vibeModeEnabled = true;
    state.isPlaying = true;
    const mounted = await mountPage();

    const pauseWave = findButton(mounted.container, "Поставить на паузу");
    assert.ok(pauseWave);
    assert.equal(pauseWave.getAttribute("data-testid"), "wave-main-toggle");
    await React.act(async () => pauseWave.click());

    assert.equal(state.pauseCount, 1);
    assert.deepEqual(state.playedTrackIds, []);

    await unmountPage(mounted);
});

test("starting Wave during Listen Together does not mutate the shared queue", async () => {
    state.listenTogetherActive = true;
    const mounted = await mountPage();

    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);
    await React.act(async () => playWave.click());

    assert.deepEqual(state.playedTrackIds, []);
    assert.equal(state.vibeModeEnabled, false);
    assert.deepEqual(state.vibeQueueIds, []);
    assert.match(
        mounted.container.querySelector('[role="status"]')?.textContent ?? "",
        /Настройка сохранена/i,
    );

    await unmountPage(mounted);
});

test("My Wave remains the primary Vibe page when local audio analysis is disabled", async () => {
    state.vibeEmbeddings = false;
    state.audioAnalysis = false;
    const mounted = await mountPage();

    assert.match(mounted.container.textContent ?? "", /Моя волна/);
    assert.match(mounted.container.textContent ?? "", /учитывает ваши вкусы/i);
    assert.doesNotMatch(
        mounted.container.textContent ?? "",
        /Feature not available|DCLAP/i,
    );
    assert.equal(state.personalizedEnabled, true);

    await unmountPage(mounted);
});

test("Tune My Wave stages a supported direction before applying it", async () => {
    const mounted = await mountPage();
    const tune = findButton(mounted.container, "Настроить");

    assert.ok(tune);
    assert.equal(mounted.container.querySelector('[role="dialog"]'), null);

    await React.act(async () => tune.click());

    const dialog = mounted.container.querySelector<HTMLElement>(
        '[role="dialog"][aria-labelledby="wave-direction-title"]',
    );
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("data-testid"), "wave-tune-sheet");
    assert.match(dialog.textContent ?? "", /Настроить мою волну/);

    const newToMe = findButtonByLabel(dialog, "Больше нового");
    const familiar = findButtonByLabel(dialog, "Знакомое");
    const directionOptions = dialog.querySelectorAll(
        '[role="radiogroup"][aria-label="Направление моей волны"] [role="radio"]',
    );

    assert.ok(newToMe);
    assert.ok(familiar);
    assert.equal(directionOptions.length, 3);
    assert.equal(
        dialog.querySelectorAll(
            '[role="radiogroup"][aria-label="Настроение моей волны"] [role="radio"]',
        ).length,
        7,
    );
    assert.match(
        dialog.textContent ?? "",
        /насколько близко держаться к истории прослушиваний/i,
    );
    assert.match(dialog.textContent ?? "", /Ваш микс/i);
    assert.match(dialog.textContent ?? "", /Открытия/i);
    assert.match(dialog.textContent ?? "", /Ближе к любимому/i);
    assert.equal(newToMe.getAttribute("role"), "radio");
    assert.equal(newToMe.getAttribute("aria-checked"), "false");
    assert.doesNotMatch(newToMe.className, /sm:min-h-\[12rem\]/);
    for (const option of directionOptions) {
        assert.doesNotMatch((option as HTMLElement).className, /\btruncate\b/);
    }

    await React.act(async () => newToMe.click());
    assert.equal(newToMe.getAttribute("aria-checked"), "true");
    assert.equal(state.personalizedMode, "for-you");

    const applyNew = findButton(dialog, "Сохранить настройку");
    assert.ok(applyNew);
    await React.act(async () => applyNew.click());
    assert.equal(state.personalizedMode, "new");
    assert.deepEqual(state.upcomingQueueCalls, []);
    assert.match(
        mounted.container.querySelector('[role="status"]')?.textContent ?? "",
        /Настройка сохранена.*следующем запуске/i,
    );
    assert.equal(mounted.container.querySelector('[role="dialog"]'), null);

    const reopenTune = findButton(mounted.container, "Настроить");
    assert.ok(reopenTune);
    await React.act(async () => reopenTune.click());

    const reopenedDialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(reopenedDialog);
    const reopenedFamiliar = findButtonByLabel(reopenedDialog, "Знакомое");
    assert.ok(reopenedFamiliar);
    await React.act(async () => reopenedFamiliar.click());

    const applyFamiliar = findButton(reopenedDialog, "Сохранить настройку");
    assert.ok(applyFamiliar);
    await React.act(async () => applyFamiliar.click());
    assert.equal(state.personalizedMode, "familiar");

    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);
    await React.act(async () => playWave.click());
    assert.deepEqual(state.playedTrackIds, ["yt:familiar-1"]);
    assert.equal(state.playedAsVibeQueue, true);
    assert.equal(state.vibeModeEnabled, true);
    assert.equal(state.waveMode, "familiar");
    assert.deepEqual(state.vibeQueueIds, ["yt:familiar-1"]);

    await unmountPage(mounted);
});

test("Tune My Wave applies mood independently and keeps both choices in the deep link", async () => {
    window.history.replaceState(
        {},
        "",
        "https://soundspan.test/vibe?mode=familiar&mood=calm",
    );
    const mounted = await mountPage();

    assert.equal(state.personalizedMode, "familiar");
    assert.equal(state.personalizedMood, "calm");

    const tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const energetic = findButtonByLabel(dialog, "Бодрое");
    const newToMe = findButtonByLabel(dialog, "Больше нового");
    assert.ok(energetic);
    assert.ok(newToMe);

    await React.act(async () => {
        energetic.click();
        newToMe.click();
    });
    assert.equal(state.personalizedMode, "familiar");
    assert.equal(state.personalizedMood, "calm");

    const apply = findButton(dialog, "Сохранить настройку");
    assert.ok(apply);
    await React.act(async () => apply.click());

    assert.equal(state.personalizedMode, "new");
    assert.equal(state.personalizedMood, "energetic");
    const url = new URL(window.location.href);
    assert.equal(url.searchParams.get("mode"), "new");
    assert.equal(url.searchParams.get("mood"), "energetic");

    await unmountPage(mounted);
});

test("applied Wave settings persist per account, URL settings override them, and Cancel stays a draft", async () => {
    state.userId = "listener-a";
    let mounted = await mountPage();
    let tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);
    await React.act(async () => tune?.click());

    let dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const familiar = findButtonByLabel(dialog, "Знакомое");
    const calm = findButtonByLabel(dialog, "Спокойное");
    assert.ok(familiar);
    assert.ok(calm);
    await React.act(async () => {
        familiar.click();
        calm.click();
    });
    const applyFamiliar = findButton(dialog, "Сохранить настройку");
    assert.ok(applyFamiliar);
    await React.act(async () => applyFamiliar.click());
    await unmountPage(mounted);

    window.history.replaceState({}, "", "https://soundspan.test/vibe");
    state.userId = "listener-b";
    mounted = await mountPage();
    assert.equal(state.personalizedMode, "for-you");
    assert.equal(state.personalizedMood, null);

    tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);
    await React.act(async () => tune.click());
    dialog = mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const newToMe = findButtonByLabel(dialog, "Больше нового");
    const energetic = findButtonByLabel(dialog, "Бодрое");
    assert.ok(newToMe);
    assert.ok(energetic);
    await React.act(async () => {
        newToMe.click();
        energetic.click();
    });
    const cancel = findButton(dialog, "Отмена");
    assert.ok(cancel);
    await React.act(async () => cancel.click());
    await unmountPage(mounted);

    window.history.replaceState({}, "", "https://soundspan.test/vibe");
    mounted = await mountPage();
    assert.equal(state.personalizedMode, "for-you");
    assert.equal(state.personalizedMood, null);
    await unmountPage(mounted);

    state.userId = "listener-a";
    window.history.replaceState(
        {},
        "",
        "https://soundspan.test/vibe?mode=new&mood=energetic",
    );
    mounted = await mountPage();
    assert.equal(state.personalizedMode, "new");
    assert.equal(state.personalizedMood, "energetic");
    await unmountPage(mounted);

    window.history.replaceState({}, "", "https://soundspan.test/vibe");
    mounted = await mountPage();
    assert.equal(state.personalizedMode, "familiar");
    assert.equal(state.personalizedMood, "calm");
    await unmountPage(mounted);
});

test("Tune after Play replaces the Wave queue and immediately starts the new direction", async () => {
    const mounted = await mountPage();
    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);

    await React.act(async () => playWave.click());
    state.currentTrack = {
        id: "yt:discovery-1",
        title: "Discovery Track",
    };

    const tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const newToMe = findButtonByLabel(dialog, "Больше нового");
    assert.ok(newToMe);
    await React.act(async () => newToMe.click());

    const applyNew = findButton(dialog, "Обновить волну");
    assert.ok(applyNew);
    await React.act(async () => {
        applyNew.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(state.personalizedMode, "new");
    assert.equal(state.waveMode, "new");
    assert.deepEqual(state.playedTrackIds, ["yt:shared-1"]);
    assert.equal(state.playedAsVibeQueue, true);
    assert.deepEqual(state.upcomingQueueCalls, []);
    assert.deepEqual(state.vibeQueueIds, ["yt:shared-1"]);

    await unmountPage(mounted);
});

test("retuning an active Wave skips the current track, starts the newly ranked queue, and confirms success", async () => {
    const mounted = await mountPage();
    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);

    await React.act(async () => playWave.click());
    state.currentTrack = { id: "yt:radio-1", title: "Quick Pick" };
    state.personalizedFeedResolver = (_mode, mood) =>
        mood === "calm"
            ? {
                  ...createPersonalizedFeed(),
                  shelves: {
                      quickPicks: [{ id: "yt:calm-1", title: "Quiet Current" }],
                      discovery: [],
                      listenAgain: [],
                  },
              }
            : createPersonalizedFeed();

    const tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const calm = findButtonByLabel(dialog, "Спокойное");
    assert.ok(calm);
    await React.act(async () => calm.click());

    const apply = findButton(dialog, "Обновить волну");
    assert.ok(apply);
    await React.act(async () => {
        apply.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(state.playedTrackIds, ["yt:calm-1"]);
    assert.equal(state.playedAsVibeQueue, true);
    assert.deepEqual(state.upcomingQueueCalls, []);
    assert.deepEqual(state.vibeQueueIds, ["yt:calm-1"]);
    assert.match(
        mounted.container.querySelector('[role="status"]')?.textContent ?? "",
        /Волна обновлена/i,
    );

    await unmountPage(mounted);
});

test("applying unchanged settings to an active Wave does not skip or rebuild playback", async () => {
    const mounted = await mountPage();
    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);

    await React.act(async () => playWave.click());
    state.currentTrack = { id: "yt:radio-1", title: "Quick Pick" };
    const originalPlayedIds = [...state.playedTrackIds];
    const originalVibeQueueIds = [...state.vibeQueueIds];

    const tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /Настройки не изменены/i);
    const apply = findButton(dialog, "Обновить волну");
    assert.ok(apply);
    await React.act(async () => {
        apply.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(state.playedTrackIds, originalPlayedIds);
    assert.deepEqual(state.vibeQueueIds, originalVibeQueueIds);
    assert.deepEqual(state.upcomingQueueCalls, []);

    await unmountPage(mounted);
});

test("retuning Wave during Listen Together saves the choice without mutating the group queue", async () => {
    const mounted = await mountPage();
    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);

    await React.act(async () => playWave.click());
    state.currentTrack = { id: "yt:radio-1", title: "Quick Pick" };
    state.listenTogetherActive = true;
    const originalPlayedIds = [...state.playedTrackIds];
    const originalVibeQueueIds = [...state.vibeQueueIds];

    const tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const newDirection = findButtonByLabel(dialog, "Больше нового");
    assert.ok(newDirection);
    await React.act(async () => newDirection.click());
    assert.match(dialog.textContent ?? "", /Текущий трек сменится/i);

    const apply = findButton(dialog, "Обновить волну");
    assert.ok(apply);
    await React.act(async () => {
        apply.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(state.personalizedMode, "new");
    assert.equal(state.waveMode, "for-you");
    assert.deepEqual(state.playedTrackIds, originalPlayedIds);
    assert.deepEqual(state.vibeQueueIds, originalVibeQueueIds);
    assert.match(
        mounted.container.querySelector('[role="status"]')?.textContent ?? "",
        /Настройка сохранена/i,
    );

    await unmountPage(mounted);
});

test("a failed active-Wave retune keeps the existing upcoming queue", async (t) => {
    const originalWindowSetTimeout = window.setTimeout;
    let scheduledRetuneDismissal = false;
    window.setTimeout = ((handler: TimerHandler, timeout?: number) => {
        if (timeout === 3_200) {
            scheduledRetuneDismissal = true;
            return 32_000;
        }
        return originalWindowSetTimeout(handler, timeout);
    }) as typeof window.setTimeout;
    t.after(() => {
        window.setTimeout = originalWindowSetTimeout;
    });
    const mounted = await mountPage();
    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);

    await React.act(async () => playWave.click());
    state.currentTrack = { id: "yt:radio-1", title: "Quick Pick" };
    const previousQueueIds = [...state.vibeQueueIds];

    const tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const calm = findButtonByLabel(dialog, "Спокойное");
    assert.ok(calm);
    await React.act(async () => calm.click());

    state.personalizedFeedError = true;
    const apply = findButton(dialog, "Обновить волну");
    assert.ok(apply);
    await React.act(async () => {
        apply.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(state.upcomingQueueCalls, []);
    assert.deepEqual(state.vibeQueueIds, previousQueueIds);
    assert.match(
        mounted.container.querySelector('[role="status"]')?.textContent ?? "",
        /Предыдущая волна продолжает играть/i,
    );
    assert.equal(state.waveMode, "for-you");
    assert.equal(state.waveMood, null);
    assert.equal(scheduledRetuneDismissal, false);
    assert.ok(findButton(mounted.container, "Повторить"));

    state.refetchRecoversError = true;
    const retryTune = findButton(mounted.container, "Настроить");
    assert.ok(retryTune);
    await React.act(async () => retryTune.click());
    const retryDialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(retryDialog);
    assert.match(retryDialog.textContent ?? "", /Текущий трек сменится/i);
    const retryApply = findButton(retryDialog, "Обновить волну");
    assert.ok(retryApply);
    await React.act(async () => {
        retryApply.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(state.refetchCalls, 1);
    assert.equal(state.waveMood, "calm");
    assert.equal(state.playedAsVibeQueue, true);
    assert.ok(state.playedTrackIds.length > 0);
    assert.doesNotMatch(state.playedTrackIds[0], /^yt:radio-1$/);
    assert.match(
        mounted.container.querySelector('[role="status"]')?.textContent ?? "",
        /Волна обновлена/i,
    );

    await unmountPage(mounted);
});

test("Tune My Wave closes on Escape without applying a draft direction", async () => {
    const mounted = await mountPage();
    const tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);

    await React.act(async () => tune.click());
    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);

    const newToMe = findButtonByLabel(dialog, "Больше нового");
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
    const tune = findButton(mounted.container, "Настроить");
    assert.ok(tune);

    await React.act(async () => tune.click());
    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);

    const forYou = findButtonByLabel(dialog, "Для вас");
    const newToMe = findButtonByLabel(dialog, "Больше нового");
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

    assert.match(mounted.container.textContent ?? "", /Сейчас играет/i);
    const inlineNowPlaying = mounted.container.querySelector<HTMLElement>(
        '[aria-labelledby="wave-now-playing-title"]',
    );
    assert.ok(inlineNowPlaying);
    assert.doesNotMatch(inlineNowPlaying.className, /(?:^|\s)hidden(?:\s|$)/);
    assert.equal(
        mounted.container.querySelector('[data-testid="wave-now-playing"]')
            ?.textContent,
        "Playing Track",
    );
    const skip = findButton(mounted.container, "Пропустить");
    assert.ok(skip);
    await React.act(async () => skip.click());
    assert.deepEqual(state.advanceOrigins, ["manual"]);

    await unmountPage(mounted);
});

test("Familiar mode falls back to quick picks when listening history is empty", async () => {
    state.personalizedFeed.shelves.listenAgain = [];
    const mounted = await mountPage();
    const tune = findButton(mounted.container, "Настроить");

    assert.ok(tune);
    await React.act(async () => tune.click());

    const dialog =
        mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const familiar = findButtonByLabel(dialog, "Знакомое");

    assert.ok(familiar);
    await React.act(async () => familiar.click());
    const applyFamiliar = findButton(dialog, "Сохранить настройку");
    assert.ok(applyFamiliar);
    await React.act(async () => applyFamiliar.click());
    const playWave = findButton(mounted.container, "Включить мою волну");
    assert.ok(playWave);
    await React.act(async () => playWave.click());
    assert.deepEqual(state.playedTrackIds, ["yt:radio-1", "yt:shared-1"]);

    await unmountPage(mounted);
});

test("Vibe still offers My Wave when the unrelated local-track list fails", async () => {
    state.embeddedTracks = 1;
    state.tracksFail = true;
    const mounted = await mountPage();

    assert.ok(findButton(mounted.container, "Включить мою волну"));
    assert.equal(state.personalizedEnabled, true);

    await unmountPage(mounted);
});

test("Vibe falls back to My Wave when analysis status is unavailable", async () => {
    state.statusFail = true;
    const mounted = await mountPage();

    assert.match(mounted.container.textContent ?? "", /Моя волна/);
    assert.match(mounted.container.textContent ?? "", /слушаете/i);
    assert.ok(findButton(mounted.container, "Включить мою волну"));
    assert.equal(state.personalizedEnabled, true);

    await unmountPage(mounted);
});

for (const embeddedTracks of [2, 4, 5]) {
    test(`Vibe stays online-first with ${embeddedTracks} legacy local embeddings`, async () => {
        state.embeddedTracks = embeddedTracks;
        const mounted = await mountPage();

        assert.match(mounted.container.textContent ?? "", /Моя волна/);
        assert.doesNotMatch(
            mounted.container.textContent ?? "",
            /Audio DNA|locally analyzed files|audio fingerprints/,
        );
        assert.ok(findButton(mounted.container, "Включить мою волну"));
        assert.equal(state.personalizedEnabled, true);
        assert.equal(findButton(mounted.container, "Map"), null);
        assert.equal(
            mounted.container.querySelector('[data-testid="vibe-map"]'),
            null,
        );

        await unmountPage(mounted);
    });
}
