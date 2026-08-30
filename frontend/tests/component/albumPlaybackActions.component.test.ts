import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const calls = {
    played: [] as string[][],
    queued: [] as string[][],
};

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (tracks: Array<{ id: string }>) =>
                calls.played.push(tracks.map((track) => track.id)),
            playTrack: () => undefined,
            playNow: () => undefined,
            addToQueue: () => undefined,
            addTracksToQueue: (tracks: Array<{ id: string }>) =>
                calls.queued.push(tracks.map((track) => track.id)),
        }),
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            error: () => undefined,
            info: () => undefined,
        },
    },
});

test("album bulk playback and queue actions omit discovery preview rows", async () => {
    const { useAlbumPlaybackActions } =
        await import("../../features/album/hooks/useAlbumPlaybackActions");
    const captured = {
        current: null as ReturnType<typeof useAlbumPlaybackActions> | null,
    };
    function Probe() {
        captured.current = useAlbumPlaybackActions();
        return null;
    }
    renderToStaticMarkup(React.createElement(Probe));

    const album = {
        id: "discovery-album",
        title: "Discovery Album",
        artist: { id: "artist-1", name: "Artist" },
        owned: false,
        source: "local" as const,
        tracks: [
            { id: "metadata-only", title: "Metadata", duration: 180 },
            {
                id: "youtube:playable",
                title: "YouTube",
                duration: 181,
                streamSource: "youtube" as const,
                youtubeVideoId: "playable",
            },
        ],
    };

    const actions = captured.current;
    if (!actions) throw new Error("Album playback actions were not captured");
    actions.playAlbum(album);
    actions.addAllToQueue(album);

    assert.deepEqual(calls.played, [["youtube:playable"]]);
    assert.deepEqual(calls.queued, [["youtube:playable"]]);
});
