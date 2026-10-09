import assert from "node:assert/strict";
import { test } from "node:test";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import { toPlayTrackRef } from "../../lib/playTrackRef";
import { toAddToPlaylistRef } from "../../lib/trackRef";

for (const provider of ["vk", "yandex"] as const) {
    const track = toMusicSourcePlaybackTrack({
        provider,
        id: provider === "vk" ? "-12_34" : "123",
        title: "Song",
        artists: ["First", "Second"],
        duration: 180.5,
        contentVersion: "explicit",
        preview: false,
    });
    test(`${provider} play reference strips credentials and keeps the full exact recording without opening playlist writes`, () => {
        assert.deepEqual(
            toPlayTrackRef({
                ...track,
                musicSourceRecording: {
                    ...track.musicSourceRecording!,
                    token: "secret",
                    streamUrl: "https://private.invalid/signed",
                } as typeof track.musicSourceRecording,
            }),
            { musicSourceRecording: track.musicSourceRecording },
        );
        assert.throws(() => toAddToPlaylistRef(track));
    });
    test(`${provider} malformed or conflicting direct identity cannot log a play`, () => {
        for (const changed of [
            { ...track, musicSourceRecording: undefined },
            { ...track, id: `${provider}:999` },
            {
                ...track,
                provider: { source: provider, providerTrackId: "other" },
            },
            { ...track, mediaSource: "youtube" as const },
            { ...track, streamSource: "youtube" as const },
            { ...track, source: "local" as const },
            { ...track, filePath: "local.flac" },
            { ...track, hasLocalFile: true },
        ])
            assert.throws(() => toPlayTrackRef(changed));
    });
}

test("play converter keeps the existing local/YouTube and retired-provider boundary", () => {
    const track = {
        id: "library-1",
        title: "Song",
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 180,
    };
    assert.deepEqual(toPlayTrackRef(track), { trackId: "library-1" });
    assert.deepEqual(
        toPlayTrackRef({
            ...track,
            id: "yt:synthetic01",
            streamSource: "youtube",
            youtubeVideoId: "synthetic01",
        }),
        {
            youtubeVideoId: "synthetic01",
            title: "Song",
            artist: "Artist",
            album: "Album",
            duration: 180,
        },
    );
    assert.throws(() =>
        toPlayTrackRef({
            ...track,
            id: "tidal:123",
            streamSource: "tidal",
            tidalTrackId: 123,
        }),
    );
});
