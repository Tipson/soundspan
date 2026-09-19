import assert from "node:assert/strict";
import test from "node:test";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import {
    normalizeActionableAudioTrack,
    isRemoteTrack,
    isPlaybackOnlyTrack,
    toAddToPlaylistRef,
} from "../../lib/trackRef";

for (const provider of ["vk", "yandex"] as const) {
    test(`${provider} catalog identity survives queue normalization without local or YouTube substitution`, () => {
        const id = provider === "vk" ? "1_2" : "123";
        const recording = {
            provider,
            id,
            title: "Song",
            artists: ["First", "Second"],
            duration: 180,
            contentVersion: "explicit" as const,
            preview: false,
        };
        const track = normalizeActionableAudioTrack(
            toMusicSourcePlaybackTrack(recording),
        );
        assert.ok(track);
        assert.equal(track.id, `${provider}:${id}`);
        assert.equal(track.streamSource, provider);
        assert.deepEqual(track.musicSourceRecording, recording);
        assert.deepEqual(
            JSON.parse(JSON.stringify(track)).musicSourceRecording,
            recording,
        );
        assert.equal(isRemoteTrack(track), true);
        assert.equal(isPlaybackOnlyTrack(track), true);
        assert.throws(() => toAddToPlaylistRef(track));
        assert.equal(
            normalizeActionableAudioTrack({
                ...track,
                id: `${provider}:other`,
            }),
            null,
        );
    });
}
test("invalid, preview and secret-bearing metadata are not admitted into queue state", () => {
    const input = {
        provider: "vk",
        id: "1_2",
        title: "Song",
        artists: ["Artist"],
        duration: 180,
        contentVersion: "unknown",
        preview: false,
        token: "secret",
        url: "https://secret",
    };
    const track = toMusicSourcePlaybackTrack(input);
    assert.equal(JSON.stringify(track).includes("secret"), false);
    assert.throws(() =>
        toMusicSourcePlaybackTrack({ ...input, preview: true }),
    );
    assert.throws(() =>
        toMusicSourcePlaybackTrack({ ...input, id: "https://localhost" }),
    );
    assert.throws(() =>
        toMusicSourcePlaybackTrack({ ...input, title: "a".repeat(201) }),
    );
    assert.throws(() =>
        toMusicSourcePlaybackTrack({ ...input, artists: ["a".repeat(101)] }),
    );
    assert.throws(() =>
        toMusicSourcePlaybackTrack({ ...input, isrc: "not-an-isrc" }),
    );
});
