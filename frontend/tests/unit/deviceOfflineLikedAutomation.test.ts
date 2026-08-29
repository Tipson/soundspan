import assert from "node:assert/strict";
import test from "node:test";
import {
    DEVICE_OFFLINE_LIKED_CHANGE_EVENT,
    isLikedPlaylistTrackDownloadable,
    likedPlaylistTrackToDeviceTrack,
    publishDeviceOfflineLikedChange,
    publishDeviceOfflineLikedChangeForSignal,
    subscribeToDeviceOfflineLikedChanges,
} from "../../features/device-offline/likedAutomation";

test("liked playlist rows retain the provider identity required for a device download", () => {
    assert.deepEqual(
        likedPlaylistTrackToDeviceTrack({
            id: "yt:video-1",
            title: "One",
            duration: 180,
            trackNo: null,
            filePath: null,
            likedAt: "2026-08-29T10:00:00.000Z",
            source: "youtube",
            provider: {
                tidalTrackId: null,
                youtubeVideoId: "video-1",
            },
            artist: { id: null, name: "Artist" },
            album: {
                id: null,
                title: "Album",
                coverArt: "cover.jpg",
            },
        }),
        {
            id: "yt:video-1",
            title: "One",
            duration: 180,
            filePath: undefined,
            source: "youtube",
            streamSource: "youtube",
            youtubeVideoId: "video-1",
            tidalTrackId: undefined,
            artist: { id: undefined, name: "Artist" },
            album: {
                id: undefined,
                title: "Album",
                coverArt: "cover.jpg",
            },
        },
    );
});

test("automatic liked downloads skip rows without a playable provider on this device", () => {
    const base = {
        id: "remote-1",
        title: "Remote",
        duration: 180,
        trackNo: null,
        filePath: null,
        likedAt: "2026-08-29T10:00:00.000Z",
        artist: { id: null, name: "Artist" },
        album: { id: null, title: "Album", coverArt: null },
    };
    assert.equal(
        isLikedPlaylistTrackDownloadable({ ...base, source: "peer" }),
        false,
    );
    assert.equal(
        isLikedPlaylistTrackDownloadable({
            ...base,
            source: "youtube",
            youtubeVideoId: "video-1",
        }),
        true,
    );
    assert.equal(
        isLikedPlaylistTrackDownloadable({
            ...base,
            source: "tidal",
            tidalTrackId: null,
        }),
        false,
    );
});

test("successful thumbs-up publishers wake only subscribed device automation", () => {
    const listeners = new Map<string, Set<EventListener>>();
    const target = {
        addEventListener(type: string, listener: EventListener) {
            const current = listeners.get(type) ?? new Set<EventListener>();
            current.add(listener);
            listeners.set(type, current);
        },
        removeEventListener(type: string, listener: EventListener) {
            listeners.get(type)?.delete(listener);
        },
        dispatchEvent(event: Event) {
            for (const listener of listeners.get(event.type) ?? []) {
                listener(event);
            }
            return true;
        },
    };
    let calls = 0;
    const unsubscribe = subscribeToDeviceOfflineLikedChanges(
        () => calls++,
        target,
    );

    publishDeviceOfflineLikedChange(target);
    assert.equal(calls, 1);
    assert.equal(
        publishDeviceOfflineLikedChangeForSignal("thumbs_up", target),
        true,
    );
    assert.equal(
        publishDeviceOfflineLikedChangeForSignal("clear", target),
        false,
    );
    assert.equal(
        publishDeviceOfflineLikedChangeForSignal("thumbs_down", target),
        false,
    );
    assert.equal(calls, 2);
    assert.equal(listeners.get(DEVICE_OFFLINE_LIKED_CHANGE_EVENT)?.size, 1);
    unsubscribe();
    publishDeviceOfflineLikedChange(target);
    assert.equal(calls, 2);
});
