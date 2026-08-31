import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const runtimeState = {
    currentTrackId: null as string | null,
    queuedTrackIds: new Set<string>(),
    overflowCalls: [] as Array<Record<string, unknown>>,
    downloadedTrackIdentities: new Set<string>(),
    inspectedOfflineTracks: [] as Array<{
        id: string;
        tidalTrackId?: number;
        youtubeVideoId?: string;
    }>,
};

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        AudioLines: Icon,
        Download: Icon,
        Music: Icon,
        Play: Icon,
    },
});

mock.module("@/utils/formatTime", {
    namedExports: {
        formatTime: (seconds: number) => `t:${seconds}`,
    },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: ({ src, alt }: { src: string; alt: string }) =>
            React.createElement("img", { src, alt }),
    },
});

mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: (props: Record<string, unknown>) => {
            runtimeState.overflowCalls.push(props);
            return React.createElement("div", null, "overflow-menu");
        },
    },
});

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: ({ trackId }: { trackId: string }) =>
            React.createElement("div", null, `prefs:${trackId}`),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: runtimeState.currentTrackId
                ? { id: runtimeState.currentTrackId }
                : null,
        }),
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => runtimeState.queuedTrackIds,
    },
});

mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        useOptionalDeviceOffline: () => ({
            recordForTrack: () => ({ status: "error" }),
            readyRecordForTrack: (track: {
                id: string;
                tidalTrackId?: number;
                youtubeVideoId?: string;
            }) => {
                runtimeState.inspectedOfflineTracks.push(track);
                const identity = track.tidalTrackId
                    ? `tidal:${track.tidalTrackId}`
                    : track.youtubeVideoId
                      ? `youtube:${track.youtubeVideoId}`
                      : `track:${track.id}`;
                return runtimeState.downloadedTrackIdentities.has(identity)
                    ? { status: "ready" }
                    : null;
            },
        }),
    },
});

beforeEach(() => {
    runtimeState.currentTrackId = null;
    runtimeState.queuedTrackIds = new Set();
    runtimeState.overflowCalls = [];
    runtimeState.downloadedTrackIdentities = new Set();
    runtimeState.inspectedOfflineTracks = [];
});

type TrackExports = {
    TrackList: (props: Record<string, unknown>) => React.ReactElement;
    TrackListHeader: (props: Record<string, unknown>) => React.ReactElement;
    TrackRow: (props: Record<string, unknown>) => React.ReactElement;
    InQueueBadge: () => React.ReactElement;
    PreviewBadge: () => React.ReactElement;
    LoadingBadge: () => React.ReactElement;
    UnplayableBadge: () => React.ReactElement;
};

async function loadTrackExports(): Promise<TrackExports> {
    const mod = await import("../../components/track");
    const named = mod as Record<string, unknown>;
    const cjsDefault =
        (mod as { default?: Record<string, unknown> }).default ?? {};
    const read = <Name extends keyof TrackExports>(
        name: Name,
    ): TrackExports[Name] => {
        const value = named[name] ?? cjsDefault[name];
        assert.ok(value, `${name} export is available`);
        return value as TrackExports[Name];
    };

    return {
        TrackList: read("TrackList"),
        TrackListHeader: read("TrackListHeader"),
        TrackRow: read("TrackRow"),
        InQueueBadge: read("InQueueBadge"),
        PreviewBadge: read("PreviewBadge"),
        LoadingBadge: read("LoadingBadge"),
        UnplayableBadge: read("UnplayableBadge"),
    };
}

const sampleItems = [
    {
        id: "track-1",
        title: "Track One",
        artist: "Artist One",
        duration: 181,
        cover: null,
    },
    {
        id: "track-2",
        title: "Track Two",
        artist: "Artist Two",
        duration: 205,
        cover: "https://img.test/2.jpg",
    },
];

function toRowItem(item: (typeof sampleItems)[number]) {
    return {
        id: item.id,
        title: item.title,
        artistName: item.artist,
        duration: item.duration,
        coverArtUrl: item.cover,
    };
}

test("TrackList renders loadingState and emptyState branches deterministically", async () => {
    const { TrackList } = await loadTrackExports();

    const loadingHtml = renderToStaticMarkup(
        React.createElement(TrackList, {
            items: sampleItems,
            toRowItem,
            onPlay: () => undefined,
            isLoading: true,
            loadingState: React.createElement("div", null, "loading-state"),
        }),
    );
    assert.match(loadingHtml, /loading-state/);

    const emptyHtml = renderToStaticMarkup(
        React.createElement(TrackList, {
            items: [],
            toRowItem,
            onPlay: () => undefined,
            isLoading: false,
            emptyState: React.createElement("div", null, "empty-state"),
        }),
    );
    assert.match(emptyHtml, /empty-state/);
});

test("TrackList computes row state for current and queued items", async () => {
    const { TrackList } = await loadTrackExports();

    runtimeState.currentTrackId = "track-2";
    runtimeState.queuedTrackIds = new Set(["track-1"]);

    const html = renderToStaticMarkup(
        React.createElement(TrackList, {
            items: sampleItems,
            toRowItem,
            onPlay: () => undefined,
            className: "track-list-root",
            rowSlots: (
                _item: (typeof sampleItems)[number],
                index: number,
                state: { isPlaying: boolean; isInQueue: boolean },
            ) => ({
                middleColumns: React.createElement(
                    "span",
                    null,
                    `state:${index}:${String(state.isPlaying)}:${String(state.isInQueue)}`,
                ),
            }),
            rowOverflow: (item: (typeof sampleItems)[number]) => ({
                track: {
                    id: item.id,
                    title: item.title,
                    duration: item.duration,
                    streamSource: "library",
                    artist: { name: item.artist },
                    album: { title: "Album" },
                },
            }),
        }),
    );

    assert.match(html, /track-list-root/);
    assert.match(html, /state:0:false:true/);
    assert.match(html, /state:1:true:false/);
    assert.equal(
        runtimeState.overflowCalls.length,
        2,
        "overflow menu receives one config per rendered row",
    );
});

test("TrackListHeader renders provided columns with shared header classes", async () => {
    const { TrackListHeader } = await loadTrackExports();

    const html = renderToStaticMarkup(
        React.createElement(TrackListHeader, {
            className: "grid-cols-[40px_1fr_auto]",
            columns: [
                { label: "#", className: "text-center" },
                { label: "Title" },
                { label: "Album" },
            ],
        }),
    );

    assert.match(html, /hidden md:grid/);
    assert.match(html, /grid-cols-\[40px_1fr_auto\]/);
    assert.match(html, /text-center/);
    assert.match(html, /Title/);
    assert.match(html, /Album/);
});

test("TrackRow renders queue badge, duration, preferences, and overflow actions", async () => {
    const { TrackRow } = await loadTrackExports();

    const html = renderToStaticMarkup(
        React.createElement(TrackRow, {
            item: {
                id: "track-1",
                title: "Playable Track",
                artistName: "Artist",
                duration: 181,
                coverArtUrl: null,
            },
            index: 0,
            isPlaying: true,
            isInQueue: true,
            accentColor: "#22c55e",
            overflowProps: {
                track: {
                    id: "track-1",
                    title: "Playable Track",
                    duration: 181,
                    streamSource: "library",
                    artist: { name: "Artist" },
                    album: { title: "Album" },
                },
            },
        }),
    );

    assert.match(html, /В ОЧЕРЕДИ/);
    assert.match(html, /t:181/);
    assert.match(html, /prefs:track-1/);
    assert.match(html, /overflow-menu/);
    assert.match(html, /color:#22c55e/);
});

test("TrackRow shows a quiet device icon only for tracks that are downloaded", async () => {
    const { TrackRow } = await loadTrackExports();
    runtimeState.downloadedTrackIdentities = new Set(["track:track-ready"]);

    const renderRow = (id: string) =>
        renderToStaticMarkup(
            React.createElement(TrackRow, {
                item: {
                    id,
                    title: `Track ${id}`,
                    artistName: "Artist",
                    duration: 181,
                    coverArtUrl: null,
                },
                index: 0,
                overflowProps: {
                    track: {
                        id,
                        title: `Track ${id}`,
                        duration: 181,
                        streamSource: "library",
                        artist: { name: "Artist" },
                        album: { title: "Album" },
                    },
                },
            }),
        );

    const readyHtml = renderRow("track-ready");
    const remoteHtml = renderRow("track-online-only");

    assert.match(readyHtml, /title="Скачано на это устройство"/);
    assert.match(readyHtml, /data-track-downloaded="true"/);
    assert.doesNotMatch(remoteHtml, /Скачано на это устройство/);
    assert.doesNotMatch(remoteHtml, /data-track-downloaded/);
});

test("TrackRow keeps the device icon when a newer download attempt failed", async () => {
    const { TrackRow } = await loadTrackExports();
    runtimeState.downloadedTrackIdentities = new Set(["track:track-ready"]);

    const html = renderToStaticMarkup(
        React.createElement(TrackRow, {
            item: {
                id: "track-ready",
                title: "Ready at another quality",
                artistName: "Artist",
                duration: 181,
                coverArtUrl: null,
            },
            index: 0,
        }),
    );

    assert.match(html, /data-track-downloaded="true"/);
});

test("TrackRow resolves downloaded state for a remote row without overflow props", async () => {
    const { TrackRow } = await loadTrackExports();
    runtimeState.downloadedTrackIdentities = new Set([
        "youtube:youtube-video-42",
    ]);

    const html = renderToStaticMarkup(
        React.createElement(TrackRow, {
            item: {
                id: "search-result-42",
                title: "Remote Track",
                artistName: "Remote Artist",
                duration: 201,
                coverArtUrl: null,
                streamSource: "youtube",
                youtubeVideoId: "youtube-video-42",
            },
            index: 0,
            overflowProps: null,
            slots: {
                trailingActions: React.createElement("span", null, "actions"),
            },
        }),
    );

    assert.match(html, /data-track-downloaded="true"/);
    assert.deepEqual(runtimeState.inspectedOfflineTracks.at(-1), {
        id: "search-result-42",
        title: "Remote Track",
        artist: { name: "Remote Artist" },
        album: { title: "" },
        duration: 201,
        streamSource: "youtube",
        tidalTrackId: undefined,
        youtubeVideoId: "youtube-video-42",
        youtubeAudioFormat: undefined,
    });
});

test("TrackRow supports slot overrides for custom row composition", async () => {
    const { TrackRow } = await loadTrackExports();

    const html = renderToStaticMarkup(
        React.createElement(TrackRow, {
            item: {
                id: "track-slot",
                title: "Slot Track",
                artistName: "Default Artist",
                duration: 90,
                coverArtUrl: null,
            },
            index: 1,
            showCoverArt: false,
            preferenceMode: null,
            overflowProps: null,
            slots: {
                leadingColumn: React.createElement("span", null, "lead-slot"),
                artistContent: React.createElement("span", null, "artist-slot"),
                trailingActions: React.createElement(
                    "span",
                    null,
                    "trail-slot",
                ),
                rowClassName: "extra-row",
            },
        }),
    );

    assert.match(html, /lead-slot/);
    assert.match(html, /artist-slot/);
    assert.match(html, /trail-slot/);
    assert.match(html, /extra-row/);
    assert.doesNotMatch(html, /prefs:/);
    assert.doesNotMatch(html, /overflow-menu/);
});

test("TrackRow enter key handler triggers play callback and prevents default", async () => {
    const { TrackRow } = await loadTrackExports();

    let playCalls = 0;
    let preventDefaultCalls = 0;
    const element = TrackRow({
        item: {
            id: "track-key",
            title: "Keyboard Track",
            artistName: "Artist",
            duration: 120,
            coverArtUrl: null,
        },
        index: 3,
        onPlay: () => {
            playCalls += 1;
        },
    });

    const onKeyDown = (
        element.props as {
            onKeyDown?: (event: {
                key: string;
                preventDefault: () => void;
            }) => void;
        }
    ).onKeyDown;
    assert.equal(typeof onKeyDown, "function");

    onKeyDown?.({
        key: "Enter",
        preventDefault: () => {
            preventDefaultCalls += 1;
        },
    });
    onKeyDown?.({
        key: "Space",
        preventDefault: () => {
            preventDefaultCalls += 1;
        },
    });

    assert.equal(playCalls, 1);
    assert.equal(preventDefaultCalls, 1);
});

test("track badges render all expected labels", async () => {
    const { InQueueBadge, PreviewBadge, LoadingBadge, UnplayableBadge } =
        await loadTrackExports();

    const html = renderToStaticMarkup(
        React.createElement(
            "div",
            null,
            React.createElement(InQueueBadge),
            React.createElement(PreviewBadge),
            React.createElement(LoadingBadge),
            React.createElement(UnplayableBadge),
        ),
    );

    assert.match(html, /В ОЧЕРЕДИ/);
    assert.match(html, /ФРАГМЕНТ/);
    assert.match(html, /ИЩЕМ/);
    assert.match(html, /НЕДОСТУПНО/);
});
