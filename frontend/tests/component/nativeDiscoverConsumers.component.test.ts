import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Track } from "../../lib/audio-state-context";
import type {
    DiscoverTrack,
    DiscoverPlaylist,
} from "../../features/discover/types";
import type { PersonalizedTrack } from "../../features/home/types";
import type { TrackListProps } from "../../components/track/types";

GlobalRegistrator.register();
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
const played: Array<{
    tracks: Track[];
    index: number;
    radio?: boolean;
    options?: unknown;
}> = [];
const now: Track[] = [];
const queued: Track[][] = [];
let statusCalls = 0;
const matches: unknown[][] = [];
let rowProps: TrackListProps<DiscoverTrack>;
const controls = {
    playTracks: (
        tracks: Track[],
        index: number,
        radio?: boolean,
        options?: unknown,
    ) => played.push({ tracks, index, radio, options }),
    playNow: (track: Track) => now.push(track),
    addTracksToQueue: (tracks: Track[]) => queued.push(tracks),
    pause() {},
    resume() {},
};
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioControls: () => controls,
        usePlaybackStatus: () => ({ isPlaying: false }),
    },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: { useAudioControls: () => controls },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getYtMusicStatus: async () => {
                statusCalls++;
                return { enabled: true, available: true };
            },
            matchYtMusicBatch: async (rows: unknown[]) => {
                matches.push(rows);
                return {
                    matches: rows.map(() => ({ videoId: "abcdefghijk" })),
                };
            },
            getCoverArtUrl: (id: string) => `/cover/${id}`,
        },
    },
});
mock.module("sonner", {
    namedExports: {
        toast: { success() {}, error() {}, info() {}, warning() {} },
    },
});
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: { useOptionalDeviceOffline: () => null },
});
mock.module("next/image", {
    defaultExport: ({ alt, src }: { alt?: string; src?: string }) =>
        React.createElement("img", { alt, src }),
});
mock.module("@/components/track", {
    namedExports: {
        TrackList: (props: TrackListProps<DiscoverTrack>) => {
            rowProps = props;
            return null;
        },
        TrackListHeader: () => null,
    },
});

function direct(provider: "vk" | "yandex"): DiscoverTrack {
    const id = provider === "vk" ? "-1_002" : "0007";
    return {
        id: `${provider}:${id}`,
        title: "Direct",
        artist: "B, A",
        album: "",
        albumId: "",
        sourceType: provider,
        streamSource: provider,
        provider: { source: provider, providerTrackId: id },
        musicSourceRecording: {
            provider,
            id,
            title: "Direct",
            artists: ["B", "A"],
            duration: 180,
            contentVersion: "unknown",
            preview: false,
        },
        duration: 180,
        recommendationGenerationId: "generation",
        available: false,
        coverUrl: null,
        tier: "high",
        similarity: 1,
        isLiked: false,
        likedAt: null,
    } as unknown as DiscoverTrack;
}
function local(): DiscoverTrack {
    return {
        id: "local",
        title: "Local",
        artist: "Artist",
        album: "Album",
        albumId: "album",
        duration: 200,
        available: true,
        sourceType: "local",
        coverUrl: null,
        tier: "high",
        similarity: 1,
        isLiked: false,
        likedAt: null,
    };
}
function personalized(row: DiscoverTrack): PersonalizedTrack {
    return {
        ...row,
        source: row.sourceType,
        artist: { name: row.artist, id: null },
        album: { title: row.album, id: null, coverArt: null },
        trackNo: null,
    } as unknown as PersonalizedTrack;
}
async function render(element: React.ReactElement) {
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    await React.act(async () => root.render(element));
    return {
        node,
        close: async () => {
            await React.act(async () => root.unmount());
            node.remove();
        },
    };
}

test("actual Discover actions preserve selected native occurrence and drop malformed queue entries", async () => {
    const { useDiscoverActions } =
        await import("../../features/discover/hooks/useDiscoverActions");
    const bad = {
        ...direct("vk"),
        musicSourceRecording: null,
    } as unknown as DiscoverTrack;
    const playlist: DiscoverPlaylist = {
        kind: "online-weekly",
        weekStart: "2026-10-05",
        weekEnd: "2026-10-12",
        generationId: "generation",
        tracks: [bad, direct("yandex"), local()],
        unavailable: [],
        totalCount: 3,
        unavailableCount: 0,
    };
    let actions: ReturnType<typeof useDiscoverActions>;
    function Probe() {
        actions = useDiscoverActions(playlist);
        return null;
    }
    const ui = await render(React.createElement(Probe));
    try {
        played.length = now.length = queued.length = 0;
        await React.act(async () => {
            actions.handlePlayPlaylist();
            actions.handlePlayTrack(1);
            actions.handlePlayTrack(0);
            actions.handleAddAllToQueue();
        });
        assert.deepEqual(
            played[0].tracks.map((x) => x.id),
            ["yandex:0007", "local"],
        );
        assert.equal(played[0].radio, false);
        assert.deepEqual(played[0].options, {
            replaceQueue: true,
            preserveOrder: true,
        });
        assert.equal(played[0].tracks[0].recommendationQueueMode, "finite");
        assert.deepEqual(
            now.map((x) => x.id),
            ["yandex:0007"],
        );
        assert.equal(now[0].provider?.providerTrackId, "0007");
        assert.deepEqual(
            queued[0].map((x) => x.id),
            ["yandex:0007", "local"],
        );
    } finally {
        await ui.close();
    }
});

test("actual gap-fill hook skips valid and malformed native claims instead of querying YouTube", async () => {
    const { useDiscoverProviderGapFill } =
        await import("../../features/discover/hooks/useDiscoverProviderGapFill");
    const rows = [
        direct("vk"),
        direct("yandex"),
        {
            ...direct("vk"),
            musicSourceRecording: null,
        } as unknown as DiscoverTrack,
    ];
    let result: ReturnType<typeof useDiscoverProviderGapFill>;
    function Probe() {
        result = useDiscoverProviderGapFill(rows);
        return null;
    }
    statusCalls = 0;
    matches.length = 0;
    const ui = await render(React.createElement(Probe));
    try {
        assert.equal(statusCalls, 0);
        assert.deepEqual(matches, []);
        assert.deepEqual(
            result!.tracks.map((x) => x.id),
            ["vk:-1_002", "yandex:0007"],
        );
        assert.equal(result!.isMatching, false);
        assert.deepEqual(result!.providerCounts, {
            local: 0,
            youtube: 0,
            vk: 1,
            yandex: 1,
        });
    } finally {
        await ui.close();
    }
});

test("actual Discover row supports native play and exact overflow without classifying it local", async () => {
    const { TrackList } =
        await import("../../features/discover/components/TrackList");
    const rows = [
        direct("vk"),
        {
            ...direct("yandex"),
            musicSourceRecording: null,
        } as unknown as DiscoverTrack,
    ];
    const indices: number[] = [];
    const ui = await render(
        React.createElement(TrackList, {
            tracks: rows,
            isMatching: false,
            isPlaying: false,
            onPlayTrack: (index: number) => indices.push(index),
            onTogglePlay() {},
        }),
    );
    try {
        assert.equal(rowProps.toRowItem(rows[0], 0).isPlayable, true);
        rowProps.onPlay(rows[0], 0);
        rowProps.onPlay(rows[1], 1);
        assert.deepEqual(indices, [0]);
        const menu = rowProps.rowOverflow!(rows[0], 0, {
            isPlaying: false,
            isInQueue: false,
        });
        assert.equal(menu?.track.streamSource, "vk");
        assert.equal(menu?.track.provider?.providerTrackId, "-1_002");
        assert.deepEqual(menu?.track.musicSourceRecording?.artists, ["B", "A"]);
        assert.equal(
            rowProps.rowOverflow!(rows[1], 1, {
                isPlaying: false,
                isInQueue: false,
            }),
            null,
        );
    } finally {
        await ui.close();
    }
});

test("mixed personalized shelf reports its actual sources and keeps finite native selection", async () => {
    const { PersonalizedTrackShelf } =
        await import("../../features/home/components/PersonalizedTrackShelf");
    const yt: PersonalizedTrack = {
        id: "yt:abcdefghijk",
        title: "YT",
        duration: 180,
        trackNo: null,
        source: "youtube",
        streamSource: "youtube",
        youtubeVideoId: "abcdefghijk",
        provider: { youtubeVideoId: "abcdefghijk", tidalTrackId: null },
        artist: { id: null, name: "YT artist" },
        album: { id: null, title: "", coverArt: null },
    };
    const ui = await render(
        React.createElement(PersonalizedTrackShelf, {
            title: "Mixed",
            tracks: [
                yt,
                personalized(direct("vk")),
                personalized(direct("yandex")),
            ],
            generationId: "shelf-generation",
        }),
    );
    try {
        assert.match(ui.node.textContent ?? "", /VK/);
        assert.match(ui.node.textContent ?? "", /Яндекс/);
        assert.match(ui.node.textContent ?? "", /YouTube/);
        played.length = 0;
        const buttons = ui.node.querySelectorAll<HTMLButtonElement>(
            'button[aria-label="Воспроизвести «Direct», исполнитель B, A"]',
        );
        assert.equal(buttons.length, 2);
        await React.act(async () => buttons[1].click());
        assert.equal(played[0].index, 2);
        assert.deepEqual(
            played[0].tracks.map((x) => x.id),
            ["yt:abcdefghijk", "vk:-1_002", "yandex:0007"],
        );
        assert.ok(
            played[0].tracks.every(
                (x) => x.recommendationQueueMode === "finite",
            ),
        );
        assert.ok(
            played[0].tracks.every(
                (x) => x.recommendationGenerationId === "shelf-generation",
            ),
        );
    } finally {
        await ui.close();
    }
});

test("malformed native shelf row cannot crash or borrow the next selected queue position", async () => {
    const { PersonalizedTrackShelf } =
        await import("../../features/home/components/PersonalizedTrackShelf");
    const bad = {
        ...personalized(direct("vk")),
        musicSourceRecording: null,
    } as unknown as PersonalizedTrack;
    const ui = await render(
        React.createElement(PersonalizedTrackShelf, {
            title: "Native",
            tracks: [bad, personalized(direct("yandex"))],
        }),
    );
    try {
        assert.equal(ui.node.querySelectorAll('[role="listitem"]').length, 1);
        played.length = 0;
        await React.act(async () =>
            ui.node
                .querySelector<HTMLButtonElement>(
                    'button[aria-label="Воспроизвести «Direct», исполнитель B, A"]',
                )!
                .click(),
        );
        assert.equal(played[0].index, 0);
        assert.equal(played[0].tracks[0].id, "yandex:0007");
    } finally {
        await ui.close();
    }
});
