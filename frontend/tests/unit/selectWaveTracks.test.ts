import assert from "node:assert/strict";
import test from "node:test";
import { selectWaveTracks } from "../../features/home/selectWaveTracks";
import type {
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "../../features/home/types";

const track = (id: string): PersonalizedTrack => ({
    id: `yt:${id}`,
    title: id,
    duration: 180,
    trackNo: null,
    artist: { id, name: id },
    album: { id: null, title: id, coverArt: null },
    source: "youtube",
    provider: { tidalTrackId: null, youtubeVideoId: id },
    streamSource: "youtube",
    youtubeVideoId: id,
});

test("For You keeps saved and recently played tracks a minority when discoveries are available", () => {
    const shelves: PersonalizedHomeFeed["shelves"] = {
        discovery: Array.from({ length: 24 }, (_, index) =>
            track(`new-${index}`),
        ),
        quickPicks: Array.from({ length: 24 }, (_, index) =>
            track(`liked-${index}`),
        ),
        listenAgain: Array.from({ length: 24 }, (_, index) =>
            track(`recent-${index}`),
        ),
    };

    const selected = selectWaveTracks(shelves, "for-you");
    const ids = selected.map((item) => item.youtubeVideoId);
    assert.equal(ids.filter((id) => id?.startsWith("new-")).length, 24);
    assert.ok(ids.filter((id) => id?.startsWith("liked-")).length <= 6);
    assert.ok(ids.filter((id) => id?.startsWith("recent-")).length <= 2);
    assert.deepEqual(ids.slice(0, 5), [
        "new-0",
        "new-1",
        "new-2",
        "new-3",
        "liked-0",
    ]);
});

test("For You keeps a playable saved-track fallback when discovery is empty", () => {
    const shelves: PersonalizedHomeFeed["shelves"] = {
        discovery: [],
        quickPicks: [track("liked")],
        listenAgain: [track("recent")],
    };
    assert.deepEqual(
        selectWaveTracks(shelves, "for-you").map((item) => item.youtubeVideoId),
        ["liked"],
    );
    assert.deepEqual(
        selectWaveTracks(shelves, "familiar").map(
            (item) => item.youtubeVideoId,
        ),
        ["recent"],
    );
});
