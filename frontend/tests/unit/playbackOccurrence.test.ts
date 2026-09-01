import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    isSamePlaybackOccurrence,
    resolvePlaybackOccurrenceMediaIdentity,
} from "@/lib/audio-engine/playbackOccurrence";

const track = {
    id: "track-a",
    title: "Track",
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 180,
};

describe("playback occurrence identity", () => {
    it("matches provider media passed through different playback surfaces", () => {
        assert.equal(
            isSamePlaybackOccurrence(
                { ...track, youtubeVideoId: "AAAAAAAAAAA" },
                {
                    ...track,
                    id: "yt:AAAAAAAAAAA",
                    provider: {
                        source: "youtube",
                        youtubeVideoId: "AAAAAAAAAAA",
                    },
                },
            ),
            true,
        );
    });

    it("keeps duplicate playlist occurrences distinct", () => {
        assert.equal(
            isSamePlaybackOccurrence(
                { ...track, playlistItemId: "item-a" },
                { ...track, playlistItemId: "item-b" },
            ),
            false,
        );
    });

    it("gives duplicate playlist rows distinct engine media identities", () => {
        assert.notEqual(
            resolvePlaybackOccurrenceMediaIdentity(
                { ...track, playlistItemId: "item-a" },
                "track-a\u0000opfs1:track-a",
            ),
            resolvePlaybackOccurrenceMediaIdentity(
                { ...track, playlistItemId: "item-b" },
                "track-a\u0000opfs1:track-a",
            ),
        );
    });
});
