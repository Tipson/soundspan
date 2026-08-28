import assert from "node:assert/strict";
import test from "node:test";
import {
    activateUserPlaybackStorage,
    getUserPlaybackStorageGeneration,
    isUserPlaybackStorageGenerationCurrent,
    revokeUserPlaybackStorage,
} from "../../lib/userPlaybackStorage";

function mapStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        storage: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        },
    };
}

test("activating an unowned playback store clears identity state but preserves device preferences", () => {
    const { values, storage } = mapStorage({
        soundspan_current_track: '{"id":"track-a"}',
        soundspan_queue: '[{"id":"track-a"}]',
        soundspan_current_time: "42",
        soundspan_is_playing: "true",
        soundspan_volume: "0.7",
        soundspan_repeat_mode: "all",
    });

    activateUserPlaybackStorage("user-a", storage);

    assert.equal(values.get("soundspan_playback_owner_id"), "user-a");
    assert.equal(values.has("soundspan_current_track"), false);
    assert.equal(values.has("soundspan_queue"), false);
    assert.equal(values.has("soundspan_current_time"), false);
    assert.equal(values.has("soundspan_is_playing"), false);
    assert.equal(values.get("soundspan_volume"), "0.7");
    assert.equal(values.get("soundspan_repeat_mode"), "all");
});

test("the same owner keeps its queue while a different owner receives an empty store", () => {
    const { values, storage } = mapStorage({
        soundspan_playback_owner_id: "user-a",
        soundspan_queue: '[{"id":"track-a"}]',
    });

    activateUserPlaybackStorage("user-a", storage);
    assert.equal(values.has("soundspan_queue"), true);

    activateUserPlaybackStorage("user-b", storage);
    assert.equal(values.get("soundspan_playback_owner_id"), "user-b");
    assert.equal(values.has("soundspan_queue"), false);
});

test("revocation invalidates stale persistence callbacks and removes ownership", () => {
    const { values, storage } = mapStorage({
        soundspan_playback_owner_id: "user-a",
        soundspan_current_track: '{"id":"track-a"}',
    });
    const generation = getUserPlaybackStorageGeneration();

    revokeUserPlaybackStorage(storage);

    assert.equal(isUserPlaybackStorageGenerationCurrent(generation), false);
    assert.equal(values.has("soundspan_playback_owner_id"), false);
    assert.equal(values.has("soundspan_current_track"), false);
});
