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

test("keeps Discoveries continuation in the selected lane, without saved backfill", () => {
    const feed: PersonalizedHomeFeed = {
        shelves: {
            discovery: [personalized("new-a"), personalized("new-b")],
            quickPicks: [personalized("liked-a")],
            listenAgain: [personalized("known-a")],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
    assert.deepEqual(
        collectProviderRadioContinuation(feed, [], 25, "new").map(
            (t) => t.youtubeVideoId,
        ),
        ["new-a", "new-b"],
    );
    assert.deepEqual(
        collectProviderRadioContinuation(
            feed,
            [personalized("new-a"), personalized("new-b")],
            25,
            "new",
        ),
        [],
    );
});

test("keeps Familiar continuation out of the discovery lane", () => {
    const feed: PersonalizedHomeFeed = {
        shelves: {
            discovery: [personalized("new")],
            quickPicks: [personalized("liked")],
            listenAgain: [personalized("known")],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
    assert.deepEqual(
        collectProviderRadioContinuation(feed, [], 25, "familiar").map(
            (t) => t.youtubeVideoId,
        ),
        ["known"],
    );
    assert.deepEqual(
        collectProviderRadioContinuation(
            { ...feed, shelves: { ...feed.shelves, listenAgain: [] } },
            [],
            25,
            "familiar",
        ).map((t) => t.youtubeVideoId),
        ["liked"],
    );
});

test("respects an empty continuation budget", () => {
    const feed: PersonalizedHomeFeed = {
        shelves: {
            discovery: [personalized("new")],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
    };
    assert.deepEqual(collectProviderRadioContinuation(feed, [], 0, "new"), []);
});

test("uses the same interleaved For You selection as the first Wave page", () => {
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
        ["fresh-b", "fresh-a"],
    );
    assert.equal(tracks[0].provider?.source, "youtube");
    assert.equal(tracks[0].album?.coverArt, "https://img.test/fresh-b.jpg");
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
        false,
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

test("does not add retired TIDAL-only rows to provider continuation", () => {
    const legacyTidal = (tidalTrackId: number) => ({
        id: `tidal:${tidalTrackId}`,
        title: String(tidalTrackId),
        duration: 180,
        trackNo: null,
        artist: {
            id: `artist-${tidalTrackId}`,
            name: `Artist ${tidalTrackId}`,
        },
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
    const feed: PersonalizedHomeFeed = {
        shelves: {
            discovery: [legacyTidal(42), personalized("fresh")],
            quickPicks: [],
            listenAgain: [],
        },
        degraded: false,
        reason: null,
        seedCount: 1,
        generationId: "generation-1",
    };

    const tracks = collectProviderRadioContinuation(feed, [], 25);

    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].youtubeVideoId, "fresh");
    assert.equal(tracks[0].recommendationGenerationId, "generation-1");
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
