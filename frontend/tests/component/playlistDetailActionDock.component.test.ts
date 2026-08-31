import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Eye: Icon,
        EyeOff: Icon,
        Globe: Icon,
        GlobeLock: Icon,
        Heart: Icon,
        ListMusic: Icon,
        Loader2: Icon,
        Pause: Icon,
        Play: Icon,
        Radio: Icon,
        Share2: Icon,
        Shuffle: Icon,
        Trash2: Icon,
    },
});

mock.module(
    "@/features/device-offline/components/DeviceCollectionDownloadButton",
    {
        namedExports: {
            DeviceCollectionDownloadButton: () =>
                React.createElement(
                    "button",
                    { className: "min-h-11" },
                    "download",
                ),
        },
    },
);

test("playlist detail action dock keeps primary and secondary actions touch-friendly", async () => {
    const { PlaylistDetailActionDock } =
        await import("@/features/playlist/components/PlaylistDetailActionDock");
    const html = renderToStaticMarkup(
        React.createElement(PlaylistDetailActionDock, {
            playlistId: "playlist-1",
            playlistName: "Редакционная подборка",
            trackItemCount: 2,
            playableTracks: [
                {
                    id: "track-1",
                    title: "Первый трек",
                    artist: { name: "Исполнитель" },
                    album: { title: "Альбом" },
                    duration: 180,
                },
                {
                    id: "track-2",
                    title: "Второй трек",
                    artist: { name: "Исполнитель" },
                    album: { title: "Альбом" },
                    duration: 190,
                },
            ],
            isThisPlaylistPlaying: false,
            isPlaying: false,
            showPlaySpinner: false,
            isAllLiked: false,
            isApplyingLikeAll: false,
            isOwner: true,
            isPublic: false,
            isHidden: false,
            isTogglingShare: false,
            isHiding: false,
            radioActions: React.createElement("span", {
                "data-radio-actions": true,
            }),
            onPlay: () => undefined,
            onShuffle: () => undefined,
            onAddAllToQueue: () => undefined,
            onToggleLikeAll: () => undefined,
            onStartRadio: () => undefined,
            onToggleShare: () => undefined,
            onOpenShare: () => undefined,
            onToggleHide: () => undefined,
            onDelete: () => undefined,
        }),
    );

    assert.match(html, /data-music-detail="actions"/);
    assert.match(html, /data-detail-action-tier="primary"/);
    assert.match(html, /data-detail-action-tier="secondary"/);
    assert.match(html, /data-radio-actions="true"/);

    for (const match of html.matchAll(/<button[^>]*>/g)) {
        assert.match(match[0], /(h-11 w-11|min-h-11)/);
    }
});
