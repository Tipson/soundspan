import assert from "node:assert/strict";
import test from "node:test";
import {
    toAudiusPlaybackTrack,
    validateAudiusPlaybackUrl,
} from "../../lib/audio/audiusPlayback";
import {
    normalizeActionableAudioTrack,
    isRemoteTrack,
    toAddToPlaylistRef,
    isPlaybackOnlyTrack,
} from "../../lib/trackRef";

const entry = {
    source: "audius" as const,
    id: "7AlA9",
    title: "Sinners (Live)",
    artist: "RAC",
    artistHandle: "RAC",
    artistVerified: true,
    durationSeconds: 237,
    attributionUrl: "https://audius.co/RAC/sinners",
    fullStreamAvailable: true as const,
    automaticFallbackEligible: false as const,
    downloadAllowed: false as const,
};
test("search result enters the queue with exact Audius identity and cannot become a local playlist write", () => {
    const queued = normalizeActionableAudioTrack(toAudiusPlaybackTrack(entry));
    assert.ok(queued);
    assert.equal(queued.id, "audius:7AlA9");
    assert.equal(queued.streamSource, "audius");
    assert.equal(queued.provider?.providerTrackId, "7AlA9");
    assert.equal(queued.title, "Sinners (Live)");
    assert.equal(queued.sourcePageUrl, entry.attributionUrl);
    assert.equal(
        JSON.parse(JSON.stringify(queued)).sourcePageUrl,
        entry.attributionUrl,
    );
    assert.equal(queued.youtubeVideoId, undefined);
    assert.equal(isRemoteTrack(queued), true);
    assert.equal(isPlaybackOnlyTrack(queued), true);
    assert.throws(() => toAddToPlaylistRef(queued), /Audius/);
});
test("playback resolution only accepts the exact official public stream URL without credentials", () => {
    const url =
        "https://creatornode.audius.co/tracks/cidstream/QmQqUCXvUESsp6j5Dp36n3i679q71UG9UNBMjT376cWRbb?signature=provider-only&skip_play_count=true";
    assert.equal(
        validateAudiusPlaybackUrl("7AlA9", {
            source: "audius",
            trackId: "7AlA9",
            streamUrl: url,
        }),
        url,
    );
    assert.throws(() =>
        validateAudiusPlaybackUrl("7AlA9", {
            source: "audius",
            trackId: "other",
            streamUrl: url,
        }),
    );
    for (const streamUrl of [
        url + "&token=secret",
        url.replace("/tracks/cidstream/", "/private/"),
        "http://127.0.0.1/private",
        "https://evil.test/file.mp3",
        url.replace("https://", "https://user:pass@"),
    ]) {
        assert.throws(() =>
            validateAudiusPlaybackUrl("7AlA9", {
                source: "audius",
                trackId: "7AlA9",
                streamUrl,
            }),
        );
    }
});

test("an explicit local file keeps local actions despite incidental Audius metadata", () => {
    const local = {
        ...toAudiusPlaybackTrack(entry),
        id: "local-recording",
        hasLocalFile: true,
    };
    assert.deepEqual(toAddToPlaylistRef(local), { trackId: "local-recording" });
    assert.equal(normalizeActionableAudioTrack(local)?.mediaSource, "local");
    assert.equal(isPlaybackOnlyTrack(local), false);
});
