import assert from "node:assert/strict";
import test from "node:test";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import { toAddToPlaylistRef } from "../../lib/trackRef";
import { extractQueueTrackInputs } from "../../lib/listenTogetherContextState";

for (const provider of ["vk", "yandex"] as const) {
    const recording = {
        provider,
        id: provider === "vk" ? "-123_456" : "123456",
        title: "Сохранённая песня",
        artists: ["Исполнитель"],
        duration: 182.5,
        contentVersion: "unknown" as const,
        preview: false as const,
    };
    test(`${provider} playlist payload keeps an exact recording without local/YouTube claims`, () => {
        const track = toMusicSourcePlaybackTrack(recording);
        assert.deepEqual(toAddToPlaylistRef(track), {
            musicSourceRecording: recording,
        });
    });
    test(`${provider} playlist payload strips unknown URL and credential fields`, () => {
        const track = toMusicSourcePlaybackTrack(recording);
        track.musicSourceRecording = {
            ...recording,
            ...{
                streamUrl: "https://private.invalid/audio",
                token: "private-token",
            },
        };
        const payload = toAddToPlaylistRef(track);
        assert.deepEqual(payload, { musicSourceRecording: recording });
        assert.doesNotMatch(
            JSON.stringify(payload),
            /private\.invalid|private-token/,
        );
    });
    test(`${provider} cannot smuggle a different id or a YouTube identity into a playlist`, () => {
        const track = toMusicSourcePlaybackTrack(recording);
        assert.throws(() =>
            toAddToPlaylistRef({ ...track, id: `${provider}:999` }),
        );
        assert.throws(() =>
            toAddToPlaylistRef({ ...track, youtubeVideoId: "dQw4w9WgXcQ" }),
        );
    });
    test(`${provider} playlist support does not broadcast native metadata into shared queues`, () => {
        const native = toMusicSourcePlaybackTrack(recording);
        assert.deepEqual(extractQueueTrackInputs([native], native), {
            queueTracks: [],
            currentTrackId: undefined,
        });
    });
    test(`${provider} current identity is excluded when a shared queue retains other local tracks`, () => {
        const native = toMusicSourcePlaybackTrack(recording);
        const local = {
            ...native,
            id: "local-row",
            filePath: "/music/song.flac",
        };
        assert.deepEqual(extractQueueTrackInputs([native, local], native), {
            queueTracks: [{ trackId: "local-row" }],
            currentTrackId: undefined,
        });
    });
    test(`real local media retains its existing playlist identity despite incidental ${provider} metadata`, () => {
        const track = {
            ...toMusicSourcePlaybackTrack(recording),
            id: "local-row",
            filePath: "/music/song.flac",
        };
        assert.deepEqual(toAddToPlaylistRef(track), { trackId: "local-row" });
    });
}

test("Audius and retired TIDAL remain outside playlist persistence", () => {
    assert.throws(() =>
        toAddToPlaylistRef({
            id: "audius:abc",
            source: "audius",
            provider: { source: "audius" },
        }),
    );
    assert.throws(() =>
        toAddToPlaylistRef({
            id: "tidal:123",
            source: "tidal",
            tidalTrackId: 123,
        }),
    );
});
