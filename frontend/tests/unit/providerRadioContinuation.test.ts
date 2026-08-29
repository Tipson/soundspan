import assert from "node:assert/strict";
import test from "node:test";
import {
    buildProviderRadioContinuationPath,
    collectProviderRadioContinuation,
    isProviderRadioTrack,
} from "../../lib/audio/providerRadioContinuation";
import type { PersonalizedHomeFeed } from "../../features/home/types";

const personalized = (videoId: string, title = videoId) => ({
    id: `yt:${videoId}`,
    title,
    duration: 180,
    trackNo: null,
    artist: { id: `artist-${videoId}`, name: `Artist ${videoId}` },
    album: {
        id: `album-${videoId}`,
        title: `Album ${videoId}`,
        coverArt: `https://img.test/${videoId}.jpg`,
    },
    source: "youtube" as const,
    provider: { tidalTrackId: null, youtubeVideoId: videoId },
    streamSource: "youtube" as const,
    youtubeVideoId: videoId,
});

test("builds fresh provider continuation with discovery first and no repeats", () => {
    const feed: PersonalizedHomeFeed = {
        shelves: {
            discovery: [personalized("seen"), personalized("fresh-a")],
            quickPicks: [personalized("fresh-b"), personalized("fresh-a")],
            listenAgain: [personalized("fresh-c")],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };

    const tracks = collectProviderRadioContinuation(
        feed,
        [
            {
                id: "yt:seen",
                youtubeVideoId: "seen",
            },
        ],
        25,
    );

    assert.deepEqual(
        tracks.map((track) => track.youtubeVideoId),
        ["fresh-a", "fresh-b", "fresh-c"],
    );
    assert.equal(tracks[0].provider?.source, "youtube");
    assert.equal(tracks[0].album?.coverArt, "https://img.test/fresh-a.jpg");
});

test("recognizes only directly playable YouTube provider tracks", () => {
    assert.equal(
        isProviderRadioTrack({
            id: "yt:abc",
            title: "Remote",
            artist: { name: "Remote Artist" },
            album: { title: "Remote Album" },
            duration: 180,
            streamSource: "youtube",
            youtubeVideoId: "abc",
        }),
        true,
    );
    assert.equal(
        isProviderRadioTrack({
            id: "local",
            title: "Local",
            artist: { name: "Local Artist" },
            album: { title: "Local Album" },
            duration: 180,
        }),
        false,
    );
});

test("builds a bounded continuation request with cursor and recent provider exclusions", () => {
    const queue = Array.from({ length: 90 }, (_, index) => ({
        id: `yt:video-${index}`,
        youtubeVideoId: `video-${index}`,
    }));

    const path = buildProviderRadioContinuationPath(queue, 7, 25, "new");
    const url = new URL(path, "https://soundspan.test");

    assert.equal(url.pathname, "/personalized/home");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(url.searchParams.get("cursor"), "7");
    assert.equal(url.searchParams.get("mode"), "new");
    const excluded = url.searchParams.get("exclude")?.split(",") ?? [];
    assert.equal(excluded.length, 80);
    assert.equal(excluded[0], "video-10");
    assert.equal(excluded.at(-1), "video-89");
});
