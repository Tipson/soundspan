import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DiscoverTrack } from "../../features/discover/types";

GlobalRegistrator.register();
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
let rows: DiscoverTrack[] = [];
const adds: unknown[] = [];
const notices: string[] = [];
let selectPlaylist: (id: string) => Promise<void>;
const Empty = () => null;
mock.module("@/lib/api", {
    namedExports: {
        api: {
            addTrackToPlaylist: async (_id: string, ref: unknown) => {
                adds.push(ref);
            },
        },
    },
});
mock.module("sonner", {
    namedExports: {
        toast: {
            success: (message: string) => notices.push(message),
            error() {},
            warning() {},
            info() {},
        },
    },
});
mock.module("@/lib/features-context", {
    namedExports: { useFeatures: () => ({ discovery: true, loading: false }) },
});
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({ currentTrack: null }),
        usePlaybackStatus: () => ({ isPlaying: false }),
        useAudioControls: () => ({
            playTracks() {},
            playNow() {},
            addTracksToQueue() {},
            pause() {},
            resume() {},
        }),
    },
});
mock.module("@/features/discover/hooks/useDiscoverData", {
    namedExports: {
        useDiscoverData: () => ({
            playlist: {
                kind: "online-weekly",
                weekStart: "2026-10-05",
                weekEnd: "2026-10-12",
                tracks: rows,
                unavailable: [],
                totalCount: rows.length,
                unavailableCount: 0,
            },
            config: null,
            loading: false,
            isGenerating: false,
            reloadData() {},
            refreshBatchStatus: async () => {},
            setConfig() {},
        }),
    },
});
mock.module("@/features/discover/hooks/useDiscoverProviderGapFill", {
    namedExports: {
        useDiscoverProviderGapFill: () => ({
            tracks: rows,
            isMatching: false,
            providerCounts: { local: 0, youtube: 0, vk: 1, yandex: 0 },
        }),
    },
});
mock.module("@/features/discover/hooks/usePreviewPlayer", {
    namedExports: {
        usePreviewPlayer: () => ({
            currentPreview: null,
            handleTogglePreview() {},
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
mock.module("@/features/discover/components/DiscoverHero", {
    namedExports: { DiscoverHero: Empty },
});
mock.module("@/features/discover/components/TrackList", {
    namedExports: { TrackList: Empty },
});
mock.module("@/features/discover/components/DiscoverSettings", {
    namedExports: { DiscoverSettings: Empty },
});
mock.module("@/features/discover/components/UnavailableAlbums", {
    namedExports: { UnavailableAlbums: Empty },
});
mock.module("@/features/discover/components/HowItWorks", {
    namedExports: { HowItWorks: Empty },
});

test("Discover bulk playlist excludes native-only recordings but keeps supported mixed rows", async () => {
    const Page = (await import("../../app/discover/page")).default;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const direct = {
        id: "vk:-1_2",
        title: "Native",
        artist: "Artist",
        album: "",
        albumId: "",
        sourceType: "vk",
        streamSource: "vk",
        provider: { source: "vk", providerTrackId: "-1_2" },
        musicSourceRecording: {
            provider: "vk",
            id: "-1_2",
            title: "Native",
            artists: ["Artist"],
            duration: 180,
            preview: false,
            contentVersion: "unknown",
        },
        duration: 180,
        available: false,
        coverUrl: null,
        similarity: 1,
        tier: "high",
        isLiked: false,
        likedAt: null,
    } as unknown as DiscoverTrack;
    const local = {
        ...direct,
        id: "local",
        title: "Local",
        sourceType: "local",
        streamSource: undefined,
        provider: undefined,
        musicSourceRecording: undefined,
        available: true,
    } as unknown as DiscoverTrack;
    try {
        rows = [direct];
        adds.length = notices.length = 0;
        await React.act(async () => root.render(React.createElement(Page)));
        assert.equal(
            Boolean(
                node.querySelector(
                    'button[aria-label="Добавить всё в плейлист"]',
                ),
            ),
            false,
        );
        await React.act(async () => selectPlaylist("playlist"));
        assert.deepEqual(adds, []);
        rows = [direct, local];
        await React.act(async () => root.render(React.createElement(Page)));
        assert.ok(
            node.querySelector('button[aria-label="Добавить всё в плейлист"]'),
        );
        await React.act(async () => selectPlaylist("playlist"));
        assert.deepEqual(adds, [{ trackId: "local" }]);
    } finally {
        await React.act(async () => root.unmount());
        node.remove();
    }
});
