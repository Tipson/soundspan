import test from "node:test";
import assert from "node:assert/strict";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";
import { toProviderPlaybackTrack } from "../../lib/audio/providerRadioContinuation";
import {
    recommendationImpressionIdentity,
    recommendationTrackKey,
} from "../../features/home/recommendationIdentity";
import type { PersonalizedTrack } from "../../features/home/types";

function row(provider: "vk" | "yandex", id: string): PersonalizedTrack {
    const track = toMusicSourcePlaybackTrack({
        provider,
        id,
        title: "Song",
        artists: ["First", "Guest"],
        duration: 180,
        contentVersion: "clean",
        preview: false,
    });
    return {
        ...track,
        trackNo: null,
        artist: { id: null, name: track.artist.name },
        album: { id: null, title: "", coverArt: null },
        provider: {
            ...track.provider,
            youtubeVideoId: null,
            tidalTrackId: null,
        },
    } as PersonalizedTrack;
}

for (const [provider, id] of [
    ["vk", "-001_002"],
    ["yandex", "0007"],
] as const) {
    test(`${provider} impressions keep exact namespace and leading zeroes`, () => {
        const track = row(provider, id);
        assert.deepEqual(recommendationImpressionIdentity(track), {
            provider,
            providerTrackId: id,
        });
        assert.equal(recommendationTrackKey(track), `${provider}:${id}`);
    });
    test(`${provider} conversion retains native metadata and strips unrelated transport fields`, () => {
        const input = {
            ...row(provider, id),
            signedUrl: "secret",
            filePath: "not-local.mp3",
        };
        const track = toProviderPlaybackTrack(input, {
            generationId: "g",
            sessionId: "s",
            queueMode: "finite",
        });
        assert.equal(track.id, `${provider}:${id}`);
        assert.equal(track.source, provider);
        assert.equal(track.mediaSource, provider);
        assert.equal(track.streamSource, provider);
        assert.deepEqual(
            track.musicSourceRecording,
            input.musicSourceRecording,
        );
        assert.equal(track.recommendationGenerationId, "g");
        assert.equal(track.recommendationSessionId, "s");
        assert.equal(track.recommendationQueueMode, "finite");
        assert.equal(track.filePath, undefined);
        assert.equal(
            (track as unknown as Record<string, unknown>).signedUrl,
            undefined,
        );
    });
}

test("conflicting native claims cannot become YouTube impressions or local playback", () => {
    const valid = row("yandex", "0007");
    for (const input of [
        { ...valid, youtubeVideoId: "video000001" },
        { ...valid, source: "library" as const },
        { ...valid, title: "Different" },
        { ...valid, id: "yandex:7" },
        {
            ...valid,
            provider: {
                ...valid.provider,
                source: "vk" as const,
                providerTrackId: "-1_2",
            },
        },
        { ...valid, musicSourceRecording: undefined },
    ]) {
        assert.equal(recommendationImpressionIdentity(input), null);
        assert.throws(() => toProviderPlaybackTrack(input), /Invalid native/);
    }
});
