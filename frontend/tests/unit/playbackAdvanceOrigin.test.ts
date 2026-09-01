import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
    consumePlaybackAdvanceOrigin,
    isPlaybackFailureSupersededByManualIntent,
    isPlaybackAutoRestartSuppressed,
    markRemoteTrackChange,
    setPlaybackAutoRestartSuppressed,
    writePlaybackAdvanceOrigin,
    writePlaybackReplacementIntent,
} from "@/lib/audio-engine/playbackAdvanceOrigin";

describe("playback advance origin", () => {
    afterEach(() => {
        writePlaybackAdvanceOrigin(null, null);
        setPlaybackAutoRestartSuppressed(false);
    });

    it("lets a manual action replace an outstanding error marker", () => {
        writePlaybackAdvanceOrigin("error", "track-a");
        writePlaybackAdvanceOrigin("manual", "track-b");

        assert.deepEqual(consumePlaybackAdvanceOrigin(), {
            origin: "manual",
            originatingTrackId: "track-b",
        });
    });

    it("identifies only a matching old occurrence as superseded by manual intent", () => {
        writePlaybackReplacementIntent("track-a");

        assert.equal(
            isPlaybackFailureSupersededByManualIntent("track-a"),
            true,
        );
        assert.equal(
            isPlaybackFailureSupersededByManualIntent("track-b"),
            false,
        );
        assert.equal(isPlaybackFailureSupersededByManualIntent(null), false);
    });

    it("does not suppress current playback failures for queue-only manual actions", () => {
        writePlaybackAdvanceOrigin("manual", "track-a");

        assert.equal(
            isPlaybackFailureSupersededByManualIntent("track-a"),
            false,
        );
    });

    it("clears replacement intent when the matching load consumes its origin", () => {
        writePlaybackReplacementIntent("track-a");

        consumePlaybackAdvanceOrigin();

        assert.equal(
            isPlaybackFailureSupersededByManualIntent("track-a"),
            false,
        );
    });

    it("keeps suppression until a manual marker reaches a playback consumer", () => {
        setPlaybackAutoRestartSuppressed(true);

        writePlaybackAdvanceOrigin("manual", "track-a");

        assert.equal(isPlaybackAutoRestartSuppressed(), true);
    });

    it("consumes an error marker exactly once", () => {
        writePlaybackAdvanceOrigin("error", "track-a");

        assert.deepEqual(consumePlaybackAdvanceOrigin(), {
            origin: "error",
            originatingTrackId: "track-a",
        });
        assert.equal(consumePlaybackAdvanceOrigin(), null);
    });

    it("marks a changed remote track as fresh media", () => {
        setPlaybackAutoRestartSuppressed(true);

        assert.equal(
            markRemoteTrackChange("track-a", "track-b"),
            "fresh-media",
        );
        assert.deepEqual(consumePlaybackAdvanceOrigin(), {
            origin: "manual",
            originatingTrackId: "track-a",
        });
        assert.equal(isPlaybackAutoRestartSuppressed(), false);
    });

    it("consumes a matching error resync marker without resetting", () => {
        writePlaybackAdvanceOrigin("error", "track-a");

        assert.equal(
            markRemoteTrackChange("track-a", "track-b"),
            "error-resync",
        );
        assert.equal(consumePlaybackAdvanceOrigin(), null);
    });

    it("replaces a stale error marker for unrelated fresh media", () => {
        writePlaybackAdvanceOrigin("error", "older-track");

        assert.equal(
            markRemoteTrackChange("track-a", "track-b"),
            "fresh-media",
        );
        assert.deepEqual(consumePlaybackAdvanceOrigin(), {
            origin: "manual",
            originatingTrackId: "track-a",
        });
    });

    it("does not consume markers when the remote track is unchanged", () => {
        writePlaybackAdvanceOrigin("error", "track-a");

        assert.equal(markRemoteTrackChange("track-a", "track-a"), "unchanged");
        assert.deepEqual(consumePlaybackAdvanceOrigin(), {
            origin: "error",
            originatingTrackId: "track-a",
        });
    });

    it("does not mark a cleared remote track as fresh media", () => {
        assert.equal(markRemoteTrackChange("track-a", null), "media-cleared");
        assert.equal(consumePlaybackAdvanceOrigin(), null);
    });
});
