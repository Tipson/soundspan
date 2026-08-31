import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const detail = {
    peer: { id: "peer-1", name: "Домашний сервер" },
    playlist: {
        remoteId: "remote-1",
        name: "Вечерняя подборка для всей семьи",
        updatedAt: "2026-08-31T00:00:00.000Z",
        owner: { displayName: "Анна" },
        tracks: [
            {
                remoteTrackId: "remote-track-1",
                title: "Доступный трек",
                artist: "Исполнитель",
                album: "Альбом",
                duration: 180,
                trackId: "track-1",
                resolution: "local",
                isResolvable: true,
                playback: {
                    isPlayable: true,
                    reason: null,
                    message: null,
                },
                track: {
                    id: "track-1",
                    title: "Доступный трек",
                    duration: 180,
                    source: "library",
                    streamSource: null,
                    album: {
                        id: "album-1",
                        title: "Альбом",
                        coverArt: null,
                        artist: {
                            id: "artist-1",
                            name: "Исполнитель",
                        },
                    },
                },
            },
            {
                remoteTrackId: "remote-track-2",
                title: "Недоступный трек",
                artist: "Другой исполнитель",
                album: "Другой альбом",
                duration: 200,
                trackId: null,
                resolution: "unresolvable",
                isResolvable: false,
                playback: {
                    isPlayable: false,
                    reason: "missing",
                    message: null,
                },
                track: null,
            },
        ],
    },
};

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Copy: Icon,
        Heart: Icon,
        ListMusic: Icon,
        Network: Icon,
        Play: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ peerId: "peer-1", remoteId: "remote-1" }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            followPeerPlaylist: async () => undefined,
            unfollowPeerPlaylist: async () => undefined,
            copyPeerPlaylist: async () => ({ copied: 1, skipped: 1 }),
        },
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioControls: () => ({
            playNow: () => undefined,
            playTracks: () => undefined,
        }),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                success: () => undefined,
                error: () => undefined,
            },
        }),
    },
});

mock.module("@/features/social/hooks/usePeerPlaylists", {
    namedExports: {
        usePeerPlaylist: () => ({
            data: detail,
            isLoading: false,
            isError: false,
        }),
        useFollowedPeerPlaylists: () => ({
            data: { playlists: [] },
            isLoading: false,
            isError: false,
        }),
    },
});

mock.module("@/components/track", {
    namedExports: {
        TrackList: () =>
            React.createElement("div", { "data-peer-track-list": true }),
    },
});

test("peer playlist uses the same editorial hierarchy without exposing federation jargon as navigation", async () => {
    const Page = (
        await import("../../app/peer-playlists/[peerId]/[remoteId]/page")
    ).default;
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            React.createElement(Page),
        ),
    );
    const hero = html.match(
        /<header[^>]*data-music-detail="hero"[\s\S]*?<\/header>/,
    )?.[0];

    assert.ok(hero);
    assert.match(hero, /Вечерняя подборка для всей семьи/);
    assert.match(hero, /data-music-detail="actions"/);
    assert.match(hero, /data-detail-action-tier="primary"/);
    assert.match(hero, /data-detail-action-tier="secondary"/);
    assert.match(hero, /Слушать/);
    assert.match(hero, /Отслеживать/);
    assert.match(hero, /Сохранить копию/);
    assert.match(html, /data-music-detail="tracks"/);
    assert.match(html, /data-peer-track-list="true"/);

    for (const match of hero.matchAll(/<button[^>]*>/g)) {
        assert.match(match[0], /min-h-11/);
    }
});
