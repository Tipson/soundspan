import assert from "node:assert/strict";
import test from "node:test";
import { ApiClientCore } from "../../lib/api/core";
import { WithLibrary } from "../../lib/api/library";
import {
    isRemoteTrack,
    isPlaybackOnlyTrack,
    resolvePreferenceTrackId,
    toAddToPlaylistRef,
    normalizeActionableAudioTrack,
    supportsTrackPreferences,
} from "../../lib/trackRef";
import {
    toAudioTrack,
    toLikedTrackActionTarget,
    type LikedPlaylistTrack,
} from "../../app/playlist/my-liked/likedPlaylistUtils";

class Client extends WithLibrary(ApiClientCore) {}
function liked(
    provider: "vk" | "yandex",
    nativeId: string,
): LikedPlaylistTrack {
    return {
        id: `${provider}:${nativeId}`,
        title: "Confirmed song",
        duration: 180,
        trackNo: null,
        filePath: null,
        likedAt: "2026-10-08T09:00:00Z",
        source: provider,
        streamSource: provider,
        provider: {
            source: provider,
            providerTrackId: nativeId,
            youtubeVideoId: null,
            tidalTrackId: null,
        },
        artist: { id: null, name: "Artist, Guest" },
        album: { id: null, title: "", coverArt: null },
        musicSourceRecording: {
            provider,
            id: nativeId,
            title: "Confirmed song",
            artists: ["Artist", "Guest"],
            duration: 180,
            contentVersion: "clean",
            preview: false,
        },
    } as LikedPlaylistTrack;
}
for (const [provider, nativeId] of [
    ["vk", "-1_2"],
    ["yandex", "0007"],
] as const) {
    test(`${provider} preference GET and POST use the exact remote endpoint`, async (t) => {
        const calls: Array<{ url: string; options?: RequestInit }> = [];
        t.mock.method(
            globalThis,
            "fetch",
            async (url: unknown, options?: RequestInit) => {
                calls.push({ url: String(url), options });
                return Response.json({
                    trackId: `${provider}:${nativeId}`,
                    signal: "clear",
                });
            },
        );
        const client = new Client("https://soundspan.test");
        await client.getTrackPreference(`${provider}:${nativeId}`);
        await client.setTrackPreference(
            `${provider}:${nativeId}`,
            "thumbs_down",
        );
        assert.equal(calls.length, 2);
        for (const call of calls)
            assert.equal(
                new URL(call.url).pathname,
                `/api/library/remote-tracks/${encodeURIComponent(`${provider}:${nativeId}`)}/preference`,
            );
        assert.deepEqual(JSON.parse(String(calls[1].options?.body)), {
            signal: "thumbs_down",
        });
    });
    test(`${provider} liked playback and row actions retain the complete exact recording`, () => {
        const row = liked(provider, nativeId);
        const track = toAudioTrack(row);
        assert.ok(track);
        assert.equal(track.id, row.id);
        assert.equal(track.provider?.source, provider);
        assert.equal(track.provider?.providerTrackId, nativeId);
        assert.deepEqual(track.musicSourceRecording, row.musicSourceRecording);
        assert.equal(track.streamSource, provider);
        assert.equal(normalizeActionableAudioTrack(track)?.id, row.id);
        assert.deepEqual(toLikedTrackActionTarget(row), track);
        assert.equal(isPlaybackOnlyTrack(track), true);
        assert.throws(() => toAddToPlaylistRef(track));
    });
    test(`${provider} preference identity does not become an incidental YouTube or TIDAL ID`, () => {
        assert.equal(
            resolvePreferenceTrackId({
                id: `${provider}:${nativeId}`,
                source: provider,
                youtubeVideoId: "stale",
                tidalTrackId: 9,
            }),
            `${provider}:${nativeId}`,
        );
        assert.equal(
            resolvePreferenceTrackId({
                id: `${provider}:${nativeId}`,
                youtubeVideoId: "stale",
            }),
            `${provider}:${nativeId}`,
        );
    });
    test(`${provider} liked projection rejects incoherent recordings`, () => {
        const row = liked(provider, nativeId);
        assert.equal(
            toAudioTrack({
                ...row,
                musicSourceRecording: {
                    ...row.musicSourceRecording!,
                    id: "mismatch",
                },
            }),
            null,
        );
        assert.equal(
            toAudioTrack({
                ...row,
                provider: { ...row.provider!, providerTrackId: "mismatch" },
            }),
            null,
        );
    });
}
test("local and federated preference identity remains persisted even with direct fallback metadata", () => {
    assert.equal(
        resolvePreferenceTrackId({
            id: "local-row",
            filePath: "/music/a.flac",
            source: "vk",
        }),
        "local-row",
    );
    assert.equal(
        resolvePreferenceTrackId({
            id: "peer-row",
            source: "federated",
            streamSource: "yandex",
        }),
        "peer-row",
    );
    assert.equal(
        isRemoteTrack({ id: "local-row", filePath: "/music/a.flac" }),
        false,
    );
});
test("direct preference eligibility rejects conflicting provider authority", () => {
    assert.equal(
        supportsTrackPreferences({ id: "vk:-1_2", source: "audius" }),
        false,
    );
    assert.equal(
        supportsTrackPreferences({
            id: "vk:-1_2",
            provider: { source: "yandex" },
        }),
        false,
    );
    assert.equal(
        supportsTrackPreferences({ id: "vk:-1_2", source: "vk" }),
        true,
    );
    assert.equal(supportsTrackPreferences({ id: "yandex:0007" }), true);
});
