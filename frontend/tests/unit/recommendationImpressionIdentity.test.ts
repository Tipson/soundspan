import assert from "node:assert/strict";
import test from "node:test";
import {
    recommendationImpressionIdentity,
    recommendationTrackKey,
} from "../../features/home/recommendationIdentity";
import type { PersonalizedTrack } from "../../features/home/types";

function track(
    source: PersonalizedTrack["source"],
    provider: PersonalizedTrack["provider"],
    id: string,
): PersonalizedTrack {
    return {
        id,
        title: id,
        duration: 180,
        trackNo: null,
        artist: { id: null, name: "Artist" },
        album: { id: null, title: "Album", coverArt: null },
        source,
        provider,
        streamSource: source,
    };
}

test("uses provider-specific impression identities for every recommendation source", () => {
    const youtube = track(
        "youtube",
        { tidalTrackId: null, youtubeVideoId: "video-1" },
        "yt:video-1",
    );
    const tidal = track(
        "tidal",
        { tidalTrackId: 42, youtubeVideoId: null },
        "tidal:42",
    );
    const local = track(
        "library",
        { tidalTrackId: null, youtubeVideoId: null },
        "local-1",
    );

    assert.deepEqual(recommendationImpressionIdentity(youtube), {
        provider: "youtube",
        providerTrackId: "video-1",
    });
    assert.deepEqual(recommendationImpressionIdentity(tidal), {
        provider: "tidal",
        providerTrackId: "42",
    });
    assert.deepEqual(recommendationImpressionIdentity(local), {
        provider: "library",
        providerTrackId: "local-1",
    });
    assert.equal(recommendationTrackKey(youtube), "youtube:video-1");
    assert.equal(recommendationTrackKey(tidal), "tidal:42");
    assert.equal(recommendationTrackKey(local), "library:local-1");
});
