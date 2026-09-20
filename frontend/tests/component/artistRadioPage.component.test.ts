import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    recordExplicitPlaybackPause,
    writePlaybackReplacementIntent,
} from "../../lib/audio-engine/playbackAdvanceOrigin";
import {
    getCollectionPlaybackGeneration,
    markCollectionPlayback,
} from "../../lib/collectionPlayback";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
let inGroup = true;
let pathname = "/artist/artist-one";
let load: () => Promise<{ tracks: unknown[] }>;
const played: unknown[][] = [];
let currentTrack: typeof track | null = null;
let resumed = 0;
let artistStarts = 0;
const noop = () => undefined;
const track = {
    id: "yt:next0000001",
    title: "Next",
    duration: 180,
    artist: { name: "Related" },
    album: { title: "Album" },
    youtubeVideoId: "next0000001",
    streamSource: "youtube",
};

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({ push: noop, back: noop }),
        usePathname: () => pathname,
        useSearchParams: () => new URLSearchParams(),
    },
});
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({ currentTrack, queue: [] }),
        usePlaybackStatus: () => ({ isPlaying: false }),
        useAudioControls: () => ({
            playTracks: (...args: unknown[]) => played.push(args),
            pause: noop,
            resume: () => {
                resumed += 1;
            },
            addTracksToQueue: noop,
        }),
    },
});
mock.module("@/lib/api", {
    namedExports: { api: { getRadioTracks: () => load() } },
});
mock.module("sonner", {
    namedExports: { toast: { success: noop, error: noop, info: noop } },
});
mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            isPendingByMbid: () => false,
            downloadsEnabled: false,
        }),
    },
});
mock.module("@/lib/listen-together-context", {
    namedExports: { useListenTogether: () => ({ isInGroup: inGroup }) },
});
mock.module("@/hooks/useImageColor", {
    namedExports: { useImageColor: () => ({ colors: null }) },
});
const hookResults: Record<string, unknown> = {
    useArtistData: {
        artist: { id: "artist-one", name: "Artist" },
        albums: [],
        source: "library",
    },
    useArtistAlbumRequests: {},
    useArtistActions: {
        playAll: () => {
            artistStarts += 1;
        },
    },
    useDownloadActions: {},
    useYtMusicTopTracks: { enrichedTopTracks: [], isStatusResolved: true },
    useArtistTracks: { tracks: [] },
    useProviderArtistTracks: { tracks: [] },
    useProviderArtistFallback: {},
};
for (const [name, result] of Object.entries(hookResults)) {
    mock.module(`@/features/artist/hooks/${name}`, {
        namedExports: { [name]: () => result },
    });
}
for (const name of [
    "ArtistBio",
    "PopularTracks",
    "Discography",
    "AvailableAlbums",
    "SimilarArtists",
    "ArtistTrackContinuation",
]) {
    mock.module(`@/features/artist/components/${name}`, {
        namedExports: { [name]: () => null },
    });
}
mock.module("@/features/artist/components/ArtistHero", {
    namedExports: {
        ArtistHero: ({ children }: { children: React.ReactNode }) => children,
    },
});
mock.module("@/features/artist/components/ArtistActionBar", {
    namedExports: {
        ArtistActionBar: ({
            onStartRadio,
            onPlayAll,
        }: {
            onStartRadio: () => void;
            onPlayAll: () => void;
        }) =>
            React.createElement(
                "div",
                null,
                React.createElement(
                    "button",
                    { onClick: onStartRadio, id: "start-radio" },
                    "Radio",
                ),
                React.createElement(
                    "button",
                    { onClick: onPlayAll, id: "play-artist" },
                    "Play",
                ),
            ),
    },
});
for (const [path, name] of [
    ["@/components/ui/LoadingScreen", "LoadingScreen"],
    ["@/components/ui/PlaylistSelector", "PlaylistSelector"],
    ["@/components/ui/ReleaseSelectionModal", "ReleaseSelectionModal"],
    ["@/features/search/components/ProviderAlbumsGrid", "ProviderAlbumsGrid"],
    [
        "@/features/library/components/SaveMusicEntityButton",
        "SaveMusicEntityButton",
    ],
    [
        "@/features/device-offline/components/DeviceCollectionDownloadButton",
        "DeviceCollectionDownloadButton",
    ],
]) {
    mock.module(path, { namedExports: { [name]: () => null } });
}
mock.module("@/features/artist/components/ArtistViewTabs", {
    namedExports: {
        ArtistViewTabs: () => null,
        resolveArtistView: () => "overview",
        buildArtistViewHref: () => "",
    },
});
mock.module("@/components/ui/ConfirmDialog", {
    namedExports: {
        ConfirmDialog: ({
            isOpen,
            onConfirm,
            onClose,
        }: {
            isOpen: boolean;
            onConfirm: () => void;
            onClose: () => void;
        }) =>
            isOpen
                ? React.createElement(
                      "div",
                      null,
                      React.createElement(
                          "button",
                          {
                              id: "confirm-radio",
                              onClick: () => {
                                  onConfirm();
                                  onClose();
                              },
                          },
                          "Confirm",
                      ),
                      React.createElement(
                          "button",
                          { id: "cancel-radio", onClick: onClose },
                          "Cancel",
                      ),
                  )
                : null,
    },
});

async function mount() {
    played.length = 0;
    pathname = "/artist/artist-one";
    const { default: ArtistPage } = await import("../../app/artist/[id]/page");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = () =>
        React.act(async () => {
            root.render(React.createElement(ArtistPage));
        });
    await render();
    return {
        container,
        render,
        click: async (id: string) => {
            const button = container.querySelector<HTMLButtonElement>(`#${id}`);
            assert.ok(button);
            await React.act(async () => button.click());
        },
        close: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("shared artist radio waits for confirmation; cancel and stale confirmation preserve the queue", async () => {
    inGroup = true;
    load = async () => ({ tracks: [track] });
    const view = await mount();
    await view.click("start-radio");
    assert.equal(played.length, 0);
    await view.click("cancel-radio");
    assert.equal(played.length, 0);
    await view.click("start-radio");
    recordExplicitPlaybackPause();
    await view.click("confirm-radio");
    assert.equal(played.length, 0);
    await view.click("start-radio");
    await view.click("confirm-radio");
    assert.equal(played.length, 1);
    assert.equal(
        (played[0][0] as (typeof track)[])[0].youtubeVideoId,
        "next0000001",
    );
    await view.close();
});

test("joining Listen Together while artist radio loads still requires confirmation", async () => {
    inGroup = false;
    let finish!: (value: { tracks: unknown[] }) => void;
    load = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    const view = await mount();
    await view.click("start-radio");
    inGroup = true;
    await view.render();
    await React.act(async () => finish({ tracks: [track] }));
    assert.equal(played.length, 0);
    assert.ok(view.container.querySelector("#confirm-radio"));
    await view.close();
});

test("leaving the artist page while radio loads cannot start its queue", async () => {
    inGroup = false;
    let finish!: (value: { tracks: unknown[] }) => void;
    load = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    const view = await mount();
    await view.click("start-radio");
    await view.close();
    await React.act(async () => finish({ tracks: [track] }));
    assert.equal(played.length, 0);
});

test("artist Play resumes its paused non-first track but starts a new queue for another owner", async () => {
    inGroup = false;
    currentTrack = {
        ...track,
        id: "yt:second00001",
        youtubeVideoId: "second00001",
    };
    resumed = 0;
    artistStarts = 0;
    const generation = getCollectionPlaybackGeneration();
    writePlaybackReplacementIntent(currentTrack.id);
    markCollectionPlayback("artist:artist-one", generation);
    recordExplicitPlaybackPause();
    const view = await mount();
    await view.click("play-artist");
    assert.equal(resumed, 1);
    assert.equal(artistStarts, 0);
    writePlaybackReplacementIntent("foreign-queue");
    await view.render();
    await view.click("play-artist");
    assert.equal(artistStarts, 1);
    assert.equal(resumed, 1);
    currentTrack = null;
    await view.close();
});
