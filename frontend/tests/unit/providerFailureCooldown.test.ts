import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createProviderFailureCooldown,
    getTrackProviderFailureKey,
} from "../../lib/audio-engine/providerFailureCooldown";

test("temporarily suppresses the same unavailable provider identity", () => {
    let nowMs = 1_000;
    const cooldown = createProviderFailureCooldown(60_000, () => nowMs);
    const key = "youtube:video-id";

    cooldown.markUnavailable(key);
    assert.equal(cooldown.isCoolingDown(key), true);

    nowMs += 60_001;
    assert.equal(cooldown.isCoolingDown(key), false);
});

test("provider failure key is shared by duplicate queue occurrences and scoped to source", () => {
    assert.equal(
        getTrackProviderFailureKey({
            id: "track-id",
            playlistItemId: "queue-item",
            streamSource: "youtube",
            youtubeVideoId: "video-id",
        }),
        "youtube:video-id",
    );
    assert.equal(
        getTrackProviderFailureKey({
            id: "track-id",
            streamSource: "tidal",
            tidalTrackId: 42,
        }),
        "tidal:42",
    );
    assert.equal(
        getTrackProviderFailureKey({
            id: "other-track",
            playlistItemId: "other-queue-item",
            streamSource: "youtube",
            youtubeVideoId: "video-id",
        }),
        getTrackProviderFailureKey({
            id: "track-id",
            playlistItemId: "queue-item",
            streamSource: "youtube",
            youtubeVideoId: "video-id",
        }),
    );
});
