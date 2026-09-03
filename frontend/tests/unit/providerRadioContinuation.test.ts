import assert from "node:assert/strict";
import test from "node:test";
import {
    buildProviderRadioContinuationPath,
    collectProviderRadioContinuation,
    isProviderRadioTrack,
    toProviderPlaybackTrack,
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

const tidalPersonalized = (
    tidalTrackId: number,
    title = String(tidalTrackId),
) => ({
    id: `tidal:${tidalTrackId}`,
    title,
    duration: 180,
    trackNo: null,
    artist: { id: `artist-${tidalTrackId}`, name: `Artist ${tidalTrackId}` },
    album: {
        id: `album-${tidalTrackId}`,
        title: `Album ${tidalTrackId}`,
        coverArt: null,
    },
    source: "tidal" as const,
    provider: { tidalTrackId, youtubeVideoId: null },
    streamSource: "tidal" as const,
    tidalTrackId,
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
            id: "tidal:42",
            title: "Remote",
            artist: { name: "Remote Artist" },
            album: { title: "Remote Album" },
            duration: 180,
            streamSource: "tidal",
            tidalTrackId: 42,
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

test("converts and deduplicates TIDAL continuation tracks without inventing YouTube ids", () => {
    const feed: PersonalizedHomeFeed = {
        shelves: {
            discovery: [tidalPersonalized(42), tidalPersonalized(43)],
            quickPicks: [tidalPersonalized(42)],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
        generationId: "generation-tidal",
    };

    const tracks = collectProviderRadioContinuation(
        feed,
        [{ id: "tidal:43", provider: { source: "tidal", tidalTrackId: 43 } }],
        25,
    );

    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].id, "tidal:42");
    assert.equal(tracks[0].source, "tidal");
    assert.equal(tracks[0].streamSource, "tidal");
    assert.equal(tracks[0].provider?.source, "tidal");
    assert.equal(tracks[0].tidalTrackId, 42);
    assert.equal(tracks[0].youtubeVideoId, undefined);
    assert.equal(tracks[0].recommendationGenerationId, "generation-tidal");
});

test("converts local recommendation rows to local playback tracks", () => {
    const track = toProviderPlaybackTrack({
        id: "local-track-1",
        title: "Local",
        duration: 120,
        trackNo: 1,
        artist: { id: "artist-1", name: "Artist" },
        album: { id: "album-1", title: "Album", coverArt: null },
        source: "library",
        provider: { tidalTrackId: null, youtubeVideoId: null },
        streamSource: "library",
    });

    assert.equal(track.id, "local-track-1");
    assert.equal(track.source, "local");
    assert.equal(track.mediaSource, "local");
    assert.equal(track.streamSource, undefined);
    assert.equal(track.provider?.source, "local");
});

test("preserves direct recommendation lineage on playback tracks", () => {
    const track = toProviderPlaybackTrack(personalized("fresh"), {
        generationId: "generation-1",
        sessionId: "session-1",
    });

    assert.equal(track.recommendationGenerationId, "generation-1");
    assert.equal(track.recommendationSessionId, "session-1");
});

test("builds a bounded continuation request with cursor and recent provider exclusions", () => {
    const queue = Array.from({ length: 90 }, (_, index) => ({
        id: `yt:video-${index}`,
        youtubeVideoId: `video-${index}`,
    }));

    const path = buildProviderRadioContinuationPath(
        queue,
        7,
        25,
        "new",
        "focus",
        {
            localHour: 9,
            timezoneOffsetMinutes: 180,
            deviceClass: "desktop",
        },
    );
    const url = new URL(path, "https://soundspan.test");

    assert.equal(url.pathname, "/personalized/home");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(url.searchParams.get("cursor"), "7");
    assert.equal(url.searchParams.get("mode"), "new");
    assert.equal(url.searchParams.get("mood"), "focus");
    assert.equal(url.searchParams.get("surface"), "wave");
    assert.equal(url.searchParams.get("localHour"), "9");
    assert.equal(url.searchParams.get("timezoneOffsetMinutes"), "180");
    assert.equal(url.searchParams.get("deviceClass"), "desktop");
    assert.ok(url.searchParams.get("sessionId"));
    const excluded = url.searchParams.get("exclude")?.split(",") ?? [];
    assert.equal(excluded.length, 80);
    assert.equal(excluded[0], "video-10");
    assert.equal(excluded.at(-1), "video-89");
});
