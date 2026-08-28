import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const calls = {
    downloads: [] as Array<Record<string, unknown>>,
    deletes: [] as string[],
    resumes: [] as string[],
    plays: [] as string[],
};

let records: Array<Record<string, unknown>> = [];
let resumeFailure: Error | null = null;
let deleteFailure: Error | null = null;
const offlineContext = {
    isHydrated: true,
    get records() {
        return records;
    },
    capability: { mode: "foreground", explanation: "Keep soundspan open." },
    download: async (input: Record<string, unknown>) => {
        calls.downloads.push(input);
        return { status: "ready" };
    },
    resume: async (record: { key: string }) => {
        calls.resumes.push(record.key);
        if (resumeFailure) throw resumeFailure;
    },
    deleteDownload: async (key: string) => {
        calls.deletes.push(key);
        if (deleteFailure) throw deleteFailure;
    },
    recordForTrack: () => null,
    refresh: async () => undefined,
};

const Icon = () => React.createElement("svg");
mock.module("lucide-react", {
    namedExports: {
        Music: Icon,
        Play: Icon,
        Radio: Icon,
        HardDriveDownload: Icon,
        RotateCcw: Icon,
        Trash2: Icon,
        EllipsisVertical: Icon,
        Link: Icon,
        ListEnd: Icon,
        ListPlus: Icon,
        Map: Icon,
        Plus: Icon,
        Share2: Icon,
        User: Icon,
        Disc3: Icon,
        AudioWaveform: Icon,
    },
});
mock.module("next/image", {
    defaultExport: ({ alt, src }: { alt?: string; src?: string }) =>
        React.createElement("img", { alt, src }),
});
mock.module("sonner", {
    exports: {
        toast: {
            success() {},
            error() {},
        },
    },
});
mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push() {} }) },
});
mock.module("@/components/ui/PlaylistSelector", {
    namedExports: { PlaylistSelector: () => null },
});
mock.module("@/components/ui/ShareLinkModal", {
    namedExports: { ShareLinkModal: () => null },
});
mock.module("@/lib/trackRef", {
    namedExports: {
        isRemoteTrack: () => false,
        toAddToPlaylistRef: () => ({ source: "local", trackId: "track" }),
    },
});
mock.module("@/lib/shareLinks", {
    namedExports: { canShareTrack: () => false },
});
mock.module("@/utils/artistRoute", {
    namedExports: { getArtistHref: () => null },
});
mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YT"),
    },
});
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        useOptionalDeviceOffline: () => offlineContext,
        useDeviceOffline: () => offlineContext,
    },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks() {},
            playNow: (track: { id: string }) => calls.plays.push(track.id),
            playNext() {},
            addToQueue() {},
            playTrack() {},
            startVibeMode: async () => ({ success: false, trackCount: 0 }),
        }),
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            getYtMusicStreamUrl: (
                id: string,
                _quality?: string,
                usePublic?: boolean,
            ) => `/api/ytmusic/${usePublic ? "stream-public" : "stream"}/${id}`,
            getTidalStreamUrl: (id: number) =>
                `/api/tidal-streaming/stream/${id}`,
            getYouTubeStreamUrl: (id: string) => `/api/youtube/stream/${id}`,
            getStreamUrl: (id: string) => `/api/library/tracks/${id}/stream`,
            addTrackToPlaylist: async () => undefined,
        },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    records = [];
    calls.downloads.length = 0;
    calls.deletes.length = 0;
    calls.resumes.length = 0;
    calls.plays.length = 0;
    resumeFailure = null;
    deleteFailure = null;
});

async function render(element: React.ReactElement) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(element));
    return {
        container,
        unmount() {
            void React.act(() => root.unmount());
            container.remove();
        },
    };
}

const track = {
    id: "yt:video-a",
    title: "Alpha",
    duration: 201,
    trackNo: null,
    artist: { id: null, name: "Artist A" },
    album: { id: null, title: "Single", coverArt: null },
    source: "youtube" as const,
    provider: { tidalTrackId: null, youtubeVideoId: "video-a" },
    streamSource: "youtube" as const,
    youtubeVideoId: "video-a",
};

test("personalized discovery exposes a real clean device-download action", async () => {
    const { PersonalizedTrackShelf } =
        await import("../../features/home/components/PersonalizedTrackShelf");
    const view = await render(
        React.createElement(PersonalizedTrackShelf, {
            title: "Quick picks",
            tracks: [track],
        }),
    );
    const button = view.container.querySelector(
        'button[aria-label="Download Alpha to this device"]',
    ) as HTMLButtonElement | null;
    assert.ok(button);
    await React.act(async () => button.click());
    assert.equal(calls.downloads.length, 1);
    assert.equal(
        calls.downloads[0].sourceUrl,
        "/api/ytmusic/stream-public/video-a",
    );
    assert.doesNotMatch(String(calls.downloads[0].sourceUrl), /token=/);
    view.unmount();
});

test("Downloads UI plays ready copies and exposes retry/delete state actions", async () => {
    const base = {
        ownerId: "user-1",
        trackIdentity: "youtube:video-a",
        quality: "auto",
        sourceUrl: "/api/ytmusic/stream/video-a",
        track,
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 6,
        totalBytes: 6,
        contentType: "audio/mpeg",
        persistenceGranted: false,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
    records = [
        {
            ...base,
            key: "ready-key",
            virtualUrl: "/__offline/audio/ready-key",
            status: "ready",
        },
        {
            ...base,
            key: "retry-key",
            virtualUrl: "/__offline/audio/retry-key",
            status: "interrupted",
            errorMessage: "Interrupted",
        },
    ];
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    await React.act(async () =>
        (
            view.container.querySelector(
                'button[aria-label="Play Alpha"]',
            ) as HTMLButtonElement
        ).click(),
    );
    await React.act(async () =>
        (
            view.container.querySelector(
                'button[aria-label="Retry Alpha"]',
            ) as HTMLButtonElement
        ).click(),
    );
    const deleteButtons = view.container.querySelectorAll(
        'button[aria-label="Delete device copy of Alpha"]',
    );
    await React.act(async () =>
        (deleteButtons[0] as HTMLButtonElement).click(),
    );

    assert.deepEqual(calls.plays, ["yt:video-a"]);
    assert.deepEqual(calls.resumes, ["retry-key"]);
    assert.deepEqual(calls.deletes, ["ready-key"]);
    view.unmount();
});

test("Downloads UI handles retry and delete failures without unhandled promises", async () => {
    records = [
        {
            ownerId: "user-1",
            trackIdentity: "youtube:video-a",
            quality: "auto",
            sourceUrl: "/api/ytmusic/stream/video-a",
            track,
            transferMode: "foreground",
            backgroundFetchId: null,
            bytesReceived: 0,
            totalBytes: null,
            contentType: null,
            persistenceGranted: false,
            attempt: 1,
            createdAt: 1,
            updatedAt: 1,
            errorCode: "interrupted",
            errorMessage: "Interrupted",
            key: "failed-key",
            virtualUrl: "/__offline/audio/failed-key",
            status: "interrupted",
        },
    ];
    resumeFailure = new Error("storage unavailable");
    deleteFailure = new Error("cache unavailable");
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    await React.act(async () => {
        (
            view.container.querySelector(
                'button[aria-label="Retry Alpha"]',
            ) as HTMLButtonElement
        ).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await React.act(async () => {
        (
            view.container.querySelector(
                'button[aria-label="Delete device copy of Alpha"]',
            ) as HTMLButtonElement
        ).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(calls.resumes, ["failed-key"]);
    assert.deepEqual(calls.deletes, ["failed-key"]);
    view.unmount();
});

test("Library exposes Downloads as a directly selectable tab", async () => {
    const selected: string[] = [];
    const { LibraryTabs } =
        await import("../../features/library/components/LibraryTabs");
    const view = await render(
        React.createElement(LibraryTabs, {
            activeTab: "tracks",
            onTabChange: (tab: string) => selected.push(tab),
        }),
    );
    const button = [...view.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Downloads",
    );
    assert.ok(button);
    await React.act(async () => button.click());
    assert.deepEqual(selected, ["downloads"]);
    view.unmount();
});

test("the shared playable-track menu exposes device download for search rows", async () => {
    const { TrackOverflowMenu } =
        await import("../../components/ui/TrackOverflowMenu");
    const playableTrack = {
        id: "search-track",
        title: "Search result",
        duration: 180,
        artist: { name: "Artist" },
        album: { title: "Album" },
    };
    const view = await render(
        React.createElement(TrackOverflowMenu, { track: playableTrack }),
    );
    await React.act(async () =>
        (
            view.container.querySelector(
                'button[aria-label="Track actions"]',
            ) as HTMLButtonElement
        ).click(),
    );
    const downloadButton = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Download to device"),
    );
    assert.ok(downloadButton);
    await React.act(async () => downloadButton.click());
    assert.equal(
        calls.downloads.at(-1)?.sourceUrl,
        "/api/library/tracks/search-track/stream",
    );
    view.unmount();
});
