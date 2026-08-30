import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    installTrackOverflowHarness,
    trackOverflowIcon,
} from "../trackOverflowHarness";
import type { Track } from "../../features/artist/types";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const metadataState: {
    calls: Array<{ artist: string; title: string; album?: string }>;
    resolve: (
        artist: string,
        title: string,
    ) => Promise<{ albumTitle: string; rgMbid: string }>;
} = {
    calls: [],
    resolve: async () => ({ albumTitle: "Resolved Album", rgMbid: "rg-123" }),
};

mock.module("lucide-react", {
    namedExports: {
        Play: trackOverflowIcon,
        Pause: trackOverflowIcon,
        Volume2: trackOverflowIcon,
        Music: trackOverflowIcon,
        ListPlus: trackOverflowIcon,
        EllipsisVertical: trackOverflowIcon,
        ListEnd: trackOverflowIcon,
        Plus: trackOverflowIcon,
        User: trackOverflowIcon,
        Disc3: trackOverflowIcon,
        AudioWaveform: trackOverflowIcon,
        Link: trackOverflowIcon,
        ChevronDown: trackOverflowIcon,
        ChevronUp: trackOverflowIcon,
    },
});

mock.module("@/utils/formatTime", {
    namedExports: { formatTime: (s: number) => String(s) },
});
mock.module("@/utils/formatNumber", {
    namedExports: { formatNumber: (n: number) => String(n) },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            addTrackToPlaylist: async () => undefined,
            getTrackAlbum: (artist: string, title: string, album?: string) => {
                metadataState.calls.push({ artist, title, album });
                return metadataState.resolve(artist, title);
            },
        },
    },
});

installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: () => undefined,
        addToQueue: () => undefined,
        playTrack: () => undefined,
        playTracks: () => undefined,
        startVibeMode: async () => ({ success: true, trackCount: 10 }),
    }),
    useAudioState: () => ({
        playbackType: "track",
        currentTrack: null,
    }),
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: props.src as string,
            alt: props.alt as string,
        }),
});

mock.module("next/link", {
    defaultExport: ({
        children,
        href,
        ...props
    }: {
        children: React.ReactNode;
        href: string;
        [key: string]: unknown;
    }) => React.createElement("a", { href, ...props }, children),
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
    },
});
mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: { useQueuedTrackIds: () => new Set<string>() },
});
mock.module("@tanstack/react-query", {
    namedExports: {
        useQueryClient: () => ({
            invalidateQueries: async () => undefined,
            setQueryData: () => undefined,
        }),
    },
});
mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        buildPreferenceMetadata: () => undefined,
        useTrackPreference: () => ({
            signal: null,
            isSaving: false,
            toggleLike: async () => undefined,
        }),
    },
});
mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: () =>
            React.createElement("div", {
                "data-testid": "track-preference-buttons",
            }),
    },
});
mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: () => undefined }) },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    metadataState.calls.length = 0;
    metadataState.resolve = async () => ({
        albumTitle: "Resolved Album",
        rgMbid: "rg-123",
    });
});

const artist = { id: "artist-1", name: "Test Artist" };

async function renderPopular(
    tracks: unknown[],
    onPlayTrack: (
        track: Track,
        index: number,
        visibleTracks: Track[],
    ) => void = () => undefined,
    showAll = false,
): Promise<{ container: HTMLElement; unmount: () => void }> {
    const { PopularTracks } =
        await import("../../features/artist/components/PopularTracks");
    const { createRoot } = await import("react-dom/client");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(PopularTracks, {
                tracks: tracks as never,
                artist: artist as never,
                currentTrackId: undefined,
                colors: null,
                onPlayTrack,
                showAll,
            }),
        );
    });
    // Drain the resolution effect's async continuations inside act so the
    // state updates are tracked and nothing leaks past the test boundary.
    await React.act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    return {
        container,
        unmount: () => {
            void React.act(() => {
                root.unmount();
            });
        },
    };
}

test("owned popular rows link the album column to the local album", async () => {
    const { container, unmount } = await renderPopular([
        {
            id: "pt1",
            title: "Owned Track",
            duration: 200,
            album: { id: "al1", title: "Album One", coverArt: null },
            artist: { id: "artist-1", name: "Test Artist" },
            filePath: "/music/track1.flac",
            playCount: 42,
        },
    ]);

    const link = container.querySelector('a[href="/album/al1"]');
    assert.ok(link, "expected an album link for the owned row");
    assert.equal(link!.textContent, "Album One");
    assert.equal(metadataState.calls.length, 0);
    unmount();
});

test("unowned popular rows resolve album identity and link to /album/<rgMbid>", async () => {
    const { container, unmount } = await renderPopular([
        {
            id: "pt2",
            title: "Unowned Track",
            duration: 180,
            album: { id: "", title: "Unknown Album", coverArt: null },
            artist: { id: "artist-1", name: "Test Artist" },
        },
    ]);

    assert.deepEqual(metadataState.calls, [
        { artist: "Test Artist", title: "Unowned Track", album: undefined },
    ]);
    const link = container.querySelector('a[href="/album/rg-123"]');
    assert.ok(link, "expected a resolved album link for the unowned row");
    assert.equal(link!.textContent, "Resolved Album");
    unmount();
});

test("unowned rows without a resolution render no album link", async () => {
    metadataState.resolve = async () => {
        throw new Error("resolution unavailable");
    };
    const { container, unmount } = await renderPopular([
        {
            id: "pt3",
            title: "Unresolvable Track",
            duration: 120,
            album: { id: "", title: "Unknown Album", coverArt: null },
            artist: { id: "artist-1", name: "Test Artist" },
        },
    ]);

    assert.equal(container.querySelector('a[href^="/album/"]'), null);
    unmount();
});

test("collapsed popular-track click forwards the exact visible queue snapshot", async () => {
    const calls: Array<{
        trackId: string;
        index: number;
        visibleIds: string[];
    }> = [];
    const tracks = Array.from({ length: 6 }, (_, index) => ({
        id: `visible-${index + 1}`,
        title: `Visible ${index + 1}`,
        duration: 180 + index,
        artist,
        album: { id: `album-${index + 1}`, title: "Album" },
        filePath: `/music/${index + 1}.flac`,
    }));
    const { container, unmount } = await renderPopular(
        tracks,
        (track, index, visibleTracks) => {
            calls.push({
                trackId: track.id as string,
                index,
                visibleIds: visibleTracks.map((item) => item.id as string),
            });
        },
    );

    const secondRow = container.querySelector<HTMLElement>(
        '[data-track-id="visible-2"]',
    );
    assert.ok(secondRow);
    await React.act(async () => secondRow.click());

    assert.deepEqual(calls, [
        {
            trackId: "visible-2",
            index: 1,
            visibleIds: [
                "visible-1",
                "visible-2",
                "visible-3",
                "visible-4",
                "visible-5",
            ],
        },
    ]);
    unmount();
});

test("tracks view exposes every returned track as the ordered playback context", async () => {
    const calls: Array<{ trackId: string; visibleIds: string[] }> = [];
    const tracks = Array.from({ length: 7 }, (_, index) => ({
        id: `all-${index + 1}`,
        title: `All ${index + 1}`,
        duration: 180 + index,
        artist,
        album: { id: `album-${index + 1}`, title: "Album" },
        filePath: `/music/all-${index + 1}.flac`,
    }));
    const { container, unmount } = await renderPopular(
        tracks,
        (track, _index, visibleTracks) => {
            calls.push({
                trackId: track.id,
                visibleIds: visibleTracks.map((item) => item.id),
            });
        },
        true,
    );

    const seventhRow = container.querySelector<HTMLElement>(
        '[data-track-id="all-7"]',
    );
    assert.ok(seventhRow, "expected the full returned track list");
    assert.equal(container.textContent?.includes("See more"), false);
    await React.act(async () => seventhRow.click());

    assert.deepEqual(calls, [
        {
            trackId: "all-7",
            visibleIds: tracks.map((track) => track.id),
        },
    ]);
    unmount();
});
