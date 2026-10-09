import assert from "node:assert/strict";
import { test } from "node:test";
import {
    getCollectionPlaybackGeneration,
    markCollectionPlayback,
    isCollectionPlayback,
} from "../../lib/collectionPlayback";
import {
    reservePlaybackIntent,
    recordExplicitPlaybackPause,
    recordExplicitPlaybackResume,
    recordExplicitPlaybackSeek,
    writePlaybackAdvanceOrigin,
    writePlaybackReplacementIntent,
} from "../../lib/audio-engine/playbackAdvanceOrigin";

test("collection ownership survives player pause, resume, seek, next and page remount", () => {
    const before = getCollectionPlaybackGeneration();
    writePlaybackReplacementIntent(null);
    markCollectionPlayback("playlist:one", before);
    assert.equal(isCollectionPlayback("playlist:one"), true);
    assert.equal(isCollectionPlayback("playlist:two"), false);
    recordExplicitPlaybackPause();
    assert.equal(isCollectionPlayback("playlist:one"), true);
    recordExplicitPlaybackResume();
    recordExplicitPlaybackSeek();
    writePlaybackAdvanceOrigin("manual", "track-1");
    assert.equal(isCollectionPlayback("playlist:one"), true);
});

test("replacing playback invalidates the previous collection even for the same track", () => {
    const before = getCollectionPlaybackGeneration();
    writePlaybackReplacementIntent(null);
    markCollectionPlayback("playlist:one", before);
    const replacement = getCollectionPlaybackGeneration();
    writePlaybackReplacementIntent("track-1");
    assert.equal(isCollectionPlayback("playlist:one"), false);
    markCollectionPlayback("playlist:two", replacement);
    assert.equal(isCollectionPlayback("playlist:one"), false);
    assert.equal(isCollectionPlayback("playlist:two"), true);
});

test("a rejected collection start cannot claim the playing queue", () => {
    const before = getCollectionPlaybackGeneration();
    writePlaybackReplacementIntent(null);
    markCollectionPlayback("playlist:one", before);
    markCollectionPlayback(
        "playlist:rejected",
        getCollectionPlaybackGeneration(),
    );
    assert.equal(isCollectionPlayback("playlist:rejected"), false);
    assert.equal(isCollectionPlayback("playlist:one"), true);
});

test("reserving radio that fails or is cancelled preserves the active collection", () => {
    const before = getCollectionPlaybackGeneration();
    writePlaybackReplacementIntent(null);
    markCollectionPlayback("playlist:one", before);
    const pending = getCollectionPlaybackGeneration();
    reservePlaybackIntent();
    assert.equal(getCollectionPlaybackGeneration(), pending);
    assert.equal(isCollectionPlayback("playlist:one"), true);
    markCollectionPlayback("radio:failed", pending);
    assert.equal(isCollectionPlayback("radio:failed"), false);
    assert.equal(isCollectionPlayback("playlist:one"), true);
    recordExplicitPlaybackPause();
    assert.equal(isCollectionPlayback("playlist:one"), true);
});
