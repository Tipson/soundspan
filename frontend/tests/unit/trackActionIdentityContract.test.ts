import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMediaSource } from "@soundspan/media-metadata-contract";
import {
    toAudioTrack,
    type LikedPlaylistTrack,
} from "../../app/playlist/my-liked/likedPlaylistUtils";
import {
    isLikedPlaylistTrackDownloadable,
    likedPlaylistTrackToDeviceTrack,
} from "../../features/device-offline/likedAutomation";
import { resolveDeviceOfflineTrackIdentity } from "../../features/device-offline/trackIdentity";
import { resolveDirectTrackSourceType } from "../../lib/audio-engine/audioPlaybackTrackPolicy";
import { isTrackActionable, toTrackRef } from "../../lib/trackRef";

// Exercise the real conversion boundaries together, without mocking source policy.
type ContractRow = LikedPlaylistTrack & {
    mediaSource?: CanonicalMediaSource;
    provider?: NonNullable<LikedPlaylistTrack["provider"]> & {
        source?: CanonicalMediaSource;
    };
};

const base: ContractRow = {
    id: "recording-one",
    title: "Song",
    duration: 180,
    trackNo: null,
    filePath: null,
    likedAt: "2026-09-05T12:00:00.000Z",
    artist: { id: null, name: "Artist" },
    album: { id: null, title: "Album", coverArt: null },
};

const cases: Array<{
    name: string;
    row: ContractRow;
    reference: { trackId: string } | { youtubeVideoId: string };
}> = [
    {
        name: "ordinary local file",
        row: { ...base, filePath: "/music/song.flac" },
        reference: { trackId: base.id },
    },
    {
        name: "real local file with incidental remote provider metadata",
        row: {
            ...base,
            filePath: "/music/song.flac",
            mediaSource: "youtube",
            streamSource: "youtube",
            youtubeVideoId: "old-video",
            tidalTrackId: 991,
            provider: {
                source: "youtube",
                youtubeVideoId: "old-video",
                tidalTrackId: 991,
            },
        },
        reference: { trackId: base.id },
    },
    {
        name: "ordinary remote YouTube",
        row: { ...base, streamSource: "youtube", youtubeVideoId: "video-one" },
        reference: { youtubeVideoId: "video-one" },
    },
    {
        name: "provider-ID-only YouTube response",
        row: {
            ...base,
            provider: { youtubeVideoId: "video-one", tidalTrackId: null },
        },
        reference: { youtubeVideoId: "video-one" },
    },
    {
        name: "canonical YouTube source",
        row: { ...base, mediaSource: "youtube", youtubeVideoId: "video-one" },
        reference: { youtubeVideoId: "video-one" },
    },
    {
        name: "authoritative provider ID overrides stale legacy ID",
        row: {
            ...base,
            id: "tidal:992",
            streamSource: "tidal",
            mediaSource: "tidal",
            tidalTrackId: 992,
            youtubeVideoId: "old-video",
            provider: {
                source: "youtube",
                youtubeVideoId: "video-one",
                tidalTrackId: null,
            },
        },
        reference: { youtubeVideoId: "video-one" },
    },
];

for (const { name, row, reference } of cases) {
    test(`actions, player and device copies agree: ${name}`, () => {
        assert.equal(isTrackActionable(row), true);
        assert.equal(isLikedPlaylistTrackDownloadable(row), true);
        assert.deepEqual(
            toTrackRef(row),
            reference,
            "playlist action identity",
        );

        const audio = toAudioTrack(row);
        assert.ok(audio, "an actionable row must produce a playable track");
        const device = likedPlaylistTrackToDeviceTrack(row);
        const isLocal = "trackId" in reference;
        const identity = isLocal
            ? `track:${reference.trackId}`
            : `youtube:${reference.youtubeVideoId}`;

        assert.equal(
            resolveDirectTrackSourceType(audio),
            isLocal ? "local" : "ytmusic",
            "the real engine must use the same provider as the action",
        );
        assert.deepEqual(toTrackRef(audio), reference, "playback identity");
        assert.equal(resolveDeviceOfflineTrackIdentity(audio), identity);
        assert.equal(resolveDeviceOfflineTrackIdentity(device), identity);
        if (!isLocal) {
            assert.equal(audio.streamSource, "youtube", "stream URL routing");
            assert.equal(audio.youtubeVideoId, reference.youtubeVideoId);
        }
    });
}

test("canonical retired-only rows stay outside playback and download paths", () => {
    const row: ContractRow = { ...base, mediaSource: "tidal" };
    assert.equal(isTrackActionable(row), false);
    assert.equal(isLikedPlaylistTrackDownloadable(row), false);
    assert.equal(toAudioTrack(row), null);
});
