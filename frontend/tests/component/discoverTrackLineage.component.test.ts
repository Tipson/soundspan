import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OverflowConfig } from "../../components/track";
import type { DiscoverTrack } from "../../features/discover/types";

const track: DiscoverTrack = {
    id: "yt:weekly",
    title: "Weekly",
    artist: "Artist",
    album: "Album",
    albumId: "album",
    duration: 180,
    coverUrl: null,
    similarity: 0,
    tier: "explore",
    available: true,
    isLiked: false,
    likedAt: null,
    sourceType: "youtube",
    streamSource: "youtube",
    youtubeVideoId: "weekly",
    recommendationGenerationId: "generation",
};
let rowMenu: OverflowConfig | undefined;
mock.module("@/components/track", {
    namedExports: {
        TrackList: (props: {
            rowOverflow: (item: DiscoverTrack) => OverflowConfig;
        }) => {
            rowMenu = props.rowOverflow(track);
            return null;
        },
        TrackListHeader: () => null,
    },
});
test("per-row queue/play-next actions preserve weekly source and generation", async () => {
    const { TrackList } =
        await import("../../features/discover/components/TrackList");
    renderToStaticMarkup(
        React.createElement(TrackList, {
            tracks: [track],
            isMatching: false,
            isPlaying: false,
            onPlayTrack: () => undefined,
            onTogglePlay: () => undefined,
        }),
    );
    assert.equal(rowMenu?.track.recommendationGenerationId, "generation");
    assert.equal(rowMenu?.track.youtubeVideoId, "weekly");
    assert.equal(rowMenu?.track.streamSource, "youtube");
});
