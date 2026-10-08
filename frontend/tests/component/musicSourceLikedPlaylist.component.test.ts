import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LikedPlaylistTrack } from "../../lib/api";
import type { Track } from "../../lib/audio-state-context";
import { ru } from "../../lib/i18n/ru";

let rows: LikedPlaylistTrack[] = [];
let selectPlaylist: (id: string) => Promise<void>;
let playRow: (track: LikedPlaylistTrack) => void;
const adds: Array<{ id: string; reference: unknown }> = [];
const queues: Array<{ tracks: Track[]; index: number }> = [];
const notices: string[] = [];
const Wrap = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
const Empty = () => null;
mock.module("lucide-react", {
    namedExports: {
        Heart: Empty,
        ListMusic: Empty,
        Loader2: Empty,
        Music: Empty,
        Plus: Empty,
        Radio: Empty,
        Shuffle: Empty,
    },
});
mock.module("@/hooks/useQueries", {
    namedExports: {
        queryKeys: {},
        useLikedPlaylistQuery: () => ({
            data: { playlist: { id: "liked" }, tracks: rows },
            isLoading: false,
            isError: false,
        }),
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            addTrackToPlaylist: async (id: string, reference: unknown) => {
                adds.push({ id, reference });
            },
        },
    },
});
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (tracks: Track[], index: number) =>
                queues.push({ tracks, index }),
            addTracksToQueue() {},
            pause() {},
            resume() {},
        }),
        useAudioState: () => ({ currentTrack: null }),
        usePlaybackStatus: () => ({ isPlaying: false }),
    },
});
mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                success: (message: string) => notices.push(message),
                error() {},
            },
        }),
    },
});
mock.module("@/components/ui/PlaylistSelector", {
    namedExports: {
        PlaylistSelector: (props: {
            onSelectPlaylist: typeof selectPlaylist;
        }) => {
            selectPlaylist = props.onSelectPlaylist;
            return null;
        },
    },
});
mock.module("@/components/track", {
    namedExports: {
        TrackList: (props: { onPlay: typeof playRow }) => {
            playRow = props.onPlay;
            return null;
        },
        TrackListHeader: Empty,
    },
});
mock.module("@/components/music-detail", {
    namedExports: {
        MusicDetailHero: (props: { actions?: React.ReactNode }) =>
            React.createElement(Wrap, null, props.actions),
        MusicDetailActionDock: Wrap,
        MusicDetailTrackSurface: Wrap,
    },
});
mock.module("@/components/music-detail/MusicDetailSecondaryActions", {
    namedExports: {
        MusicDetailSecondaryActions: ({
            children,
        }: {
            children: (close: () => void) => React.ReactNode;
        }) => children(() => undefined),
    },
});
mock.module("@/components/ui/CachedImage", {
    namedExports: { CachedImage: Empty },
});
mock.module("@/components/music-detail/CollectionPlaybackButton", {
    namedExports: { CollectionPlaybackButton: Empty },
});
mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: { TrackPreferenceButtons: Empty },
});
mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: { TrackOverflowMenu: Empty },
});
mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: Empty },
});
mock.module(
    "@/features/device-offline/components/DeviceCollectionDownloadButton",
    { namedExports: { DeviceCollectionDownloadButton: Empty } },
);

before(() => {
    GlobalRegistrator.register();
    (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());
const local: LikedPlaylistTrack = {
    id: "local-song",
    title: "Local",
    duration: 180,
    filePath: "song.flac",
    trackNo: null,
    likedAt: "2026-10-08T09:00:00Z",
    source: "local",
    artist: { id: "artist", name: "Artist" },
    album: { id: "album", title: "Album", coverArt: null },
};
function direct(provider: "vk" | "yandex"): LikedPlaylistTrack {
    const nativeId = provider === "vk" ? "-1_2" : "0007";
    return {
        ...local,
        id: `${provider}:${nativeId}`,
        filePath: null,
        source: provider,
        streamSource: provider,
        provider: {
            source: provider,
            providerTrackId: nativeId,
            youtubeVideoId: null,
            tidalTrackId: null,
        },
        musicSourceRecording: {
            provider,
            id: nativeId,
            title: "Direct",
            artists: ["Artist"],
            duration: 180,
            contentVersion: "clean",
            preview: false,
        },
    };
}
for (const provider of ["vk", "yandex"] as const) {
    test(`${provider} likes remain playable while bulk playlists accept only persistent rows`, async () => {
        const Page = (await import("../../app/playlist/my-liked/pageContent"))
            .default;
        const node = document.createElement("div");
        document.body.append(node);
        const root = createRoot(node);
        const client = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false },
            },
        });
        const render = () =>
            root.render(
                React.createElement(
                    QueryClientProvider,
                    { client },
                    React.createElement(Page),
                ),
            );
        try {
            rows = [direct(provider)];
            adds.length = queues.length = notices.length = 0;
            await React.act(async () => render());
            const button = node.querySelector(
                `button[aria-label="${ru.playlist.addAllPlaylist}"]`,
            ) as HTMLButtonElement;
            assert.ok(button);
            assert.equal(button.disabled, true);
            await React.act(async () => selectPlaylist("playlist"));
            assert.deepEqual(adds, []);
            rows = [direct(provider), local];
            await React.act(async () => render());
            assert.equal(
                (
                    node.querySelector(
                        `button[aria-label="${ru.playlist.addAllPlaylist}"]`,
                    ) as HTMLButtonElement
                ).disabled,
                false,
            );
            await React.act(async () => selectPlaylist("playlist"));
            assert.deepEqual(adds, [
                { id: "playlist", reference: { trackId: "local-song" } },
            ]);
            assert.match(notices.at(-1)!, /1 трек$/);
            await React.act(async () => playRow(local));
            assert.deepEqual(
                queues[0].tracks.map((track) => track.id),
                [rows[0].id, local.id],
            );
            assert.equal(queues[0].index, 1);
            assert.deepEqual(
                queues[0].tracks[0].musicSourceRecording,
                rows[0].musicSourceRecording,
            );
        } finally {
            await React.act(async () => root.unmount());
            client.clear();
            node.remove();
        }
    });
}
