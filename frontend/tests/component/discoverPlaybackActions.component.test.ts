import { writePlaybackReplacementIntent } from "../../lib/audio-engine/playbackAdvanceOrigin";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isCollectionPlayback } from "../../lib/collectionPlayback";
import type { DiscoverPlaylist } from "../../features/discover/types";
const calls: Array<{ ids: string[]; index: number; options: unknown }> = [];
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (
                tracks: Array<{ id: string }>,
                index: number,
                _radio: boolean,
                options: unknown,
            ) => {
                writePlaybackReplacementIntent(null);
                calls.push({ ids: tracks.map((t) => t.id), index, options });
            },
            playNow: () => undefined,
            addTracksToQueue: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
        }),
        usePlaybackStatus: () => ({ isPlaying: false }),
    },
});
test("Discover starts ordered playback and identifies the active weekly collection", async () => {
    const { useDiscoverActions } =
        await import("../../features/discover/hooks/useDiscoverActions");
    const playlist = {
        weekStart: "2026-09-20",
        weekEnd: "2026-09-27",
        unavailable: [],
        totalCount: 2,
        unavailableCount: 0,
        tracks: ["one", "two"].map((id) => ({
            id,
            title: id,
            artist: "Artist",
            album: "Album",
            albumId: "album",
            available: true,
            duration: 180,
            isLiked: false,
            likedAt: null,
            similarity: 1,
            tier: "high" as const,
            coverUrl: null,
        })),
    } satisfies DiscoverPlaylist;
    let actions: ReturnType<typeof useDiscoverActions> | undefined;
    function Probe() {
        actions = useDiscoverActions(playlist);
        return null;
    }
    renderToStaticMarkup(React.createElement(Probe));
    actions!.handlePlayPlaylist();
    assert.equal(isCollectionPlayback("discover:2026-09-20"), true);
    assert.deepEqual(calls[0], {
        ids: ["one", "two"],
        index: 0,
        options: { replaceQueue: true, preserveOrder: true },
    });
});
