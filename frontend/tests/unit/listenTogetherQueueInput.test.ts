import assert from "node:assert/strict";
import test from "node:test";
import {
    extractQueueTrackInputs,
    toLocalTrack,
} from "../../lib/listenTogetherContextState";
import type { Track } from "../../lib/audio-state-context";
import {
    isTrackActionable,
    resolvePreferenceTrackId,
} from "../../lib/trackRef";

function track(id: string, overrides: Partial<Track> = {}): Track {
    return {
        id,
        title: id,
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 180,
        ...overrides,
    };
}

test("Listen Together queue drops retired TIDAL without losing supported or local-backed rows", () => {
    const local = track("local-1");
    const retiredTidal = track("tidal:991", {
        streamSource: "tidal",
        tidalTrackId: 991,
    });
    const activeYouTube = track("tidal:992", {
        source: "youtube",
        youtubeVideoId: "active-video",
    });
    const localWithStaleTidal = track("local-stale-tidal", {
        filePath: "/music/local.flac",
        streamSource: "tidal",
        tidalTrackId: 993,
    });

    const result = extractQueueTrackInputs(
        [local, retiredTidal, activeYouTube, localWithStaleTidal],
        retiredTidal,
    );

    assert.deepEqual(result, {
        queueTracks: [
            { trackId: "local-1" },
            {
                youtubeVideoId: "active-video",
                title: "tidal:992",
                artist: "Artist",
                album: "Album",
                duration: 180,
            },
            { trackId: "local-stale-tidal" },
        ],
        currentTrackId: undefined,
    });

    assert.equal(
        extractQueueTrackInputs(
            [local, activeYouTube, localWithStaleTidal],
            activeYouTube,
        ).currentTrackId,
        "yt:active-video",
    );
});

test("Listen Together availability remap replaces stale TIDAL authority with YouTube", () => {
    const mapped = toLocalTrack(
        {
            id: "tidal:991",
            title: "Recovered",
            duration: 180,
            artist: { id: "artist-1", name: "Artist" },
            album: { id: "album-1", title: "Album", coverArt: null },
            mediaSource: "tidal",
            provider: {
                source: "tidal",
                providerTrackId: "991",
                tidalTrackId: 991,
            },
            streamSource: "tidal",
            tidalTrackId: 991,
            originSource: "tidal",
        },
        {
            queueIndex: 0,
            available: true,
            source: "youtube",
            youtubeVideoId: "active-video",
        },
    );

    assert.deepEqual(
        {
            mediaSource: mapped.mediaSource,
            providerSource: mapped.provider?.source,
            providerTrackId: mapped.provider?.providerTrackId,
            streamSource: mapped.streamSource,
            tidalTrackId: mapped.tidalTrackId,
            youtubeVideoId: mapped.youtubeVideoId,
        },
        {
            mediaSource: "youtube",
            providerSource: "youtube",
            providerTrackId: "active-video",
            streamSource: "youtube",
            tidalTrackId: undefined,
            youtubeVideoId: "active-video",
        },
    );
    assert.equal(isTrackActionable(mapped), true);
    assert.equal(resolvePreferenceTrackId(mapped), "yt:active-video");
});

test("Listen Together local availability remap clears stale remote authority", () => {
    const mapped = toLocalTrack(
        {
            id: "tidal:991",
            title: "Recovered locally",
            duration: 180,
            artist: { id: "artist-1", name: "Artist" },
            album: { id: "album-1", title: "Album", coverArt: null },
            mediaSource: "tidal",
            provider: {
                source: "tidal",
                providerTrackId: "991",
                tidalTrackId: 991,
            },
            streamSource: "tidal",
            tidalTrackId: 991,
            originSource: "tidal",
        },
        {
            queueIndex: 0,
            available: true,
            source: "local",
            localTrackId: "local-track-1",
        },
    );

    assert.deepEqual(
        {
            id: mapped.id,
            mediaSource: mapped.mediaSource,
            provider: mapped.provider,
            streamSource: mapped.streamSource,
            tidalTrackId: mapped.tidalTrackId,
            youtubeVideoId: mapped.youtubeVideoId,
        },
        {
            id: "local-track-1",
            mediaSource: "local",
            provider: { source: "local" },
            streamSource: undefined,
            tidalTrackId: undefined,
            youtubeVideoId: undefined,
        },
    );
    assert.equal(isTrackActionable(mapped), true);
    assert.equal(resolvePreferenceTrackId(mapped), "local-track-1");
});
