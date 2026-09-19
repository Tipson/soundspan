import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRecoveredMusicSource } from "../../lib/audio/loadRecoveredMusicSource";
import type {
    AudioEngine,
    AudioEngineEventHandler,
    AudioEngineEventType,
    AudioEngineEventPayloadMap,
} from "../../lib/audio-engine/types";

function fixture() {
    const events = new EventTarget();
    const listeners = new Map<unknown, EventListener>();
    const calls: unknown[][] = [];
    const engine: Pick<AudioEngine, "load" | "on" | "off" | "seek" | "play"> = {
        load: (...args) => {
            calls.push(["load", ...args]);
        },
        seek: (position) => {
            calls.push(["seek", position]);
        },
        play: () => {
            calls.push(["play"]);
        },
        on<T extends AudioEngineEventType>(
            event: T,
            callback: AudioEngineEventHandler<T>,
        ) {
            const listener = (e: Event) =>
                callback(
                    (e as CustomEvent<AudioEngineEventPayloadMap[T]>).detail,
                );
            listeners.set(callback, listener);
            events.addEventListener(event, listener);
        },
        off: (event, callback) => {
            const listener = listeners.get(callback);
            if (listener) events.removeEventListener(event, listener);
            listeners.delete(callback);
        },
    };
    const controller = new AbortController();
    let current = true;
    const start = () =>
        loadRecoveredMusicSource({
            engine,
            url: "/api/music-sources/leases/test/stream",
            trackId: "original",
            positionSec: 73.5,
            durationSec: 240,
            signal: controller.signal,
            isCurrent: () => current,
            onReady: () => {
                calls.push(["ready"]);
            },
        });
    return {
        engine,
        calls,
        listeners,
        controller,
        start,
        retire: () => {
            current = false;
        },
        emit: (event: string, detail: unknown) =>
            events.dispatchEvent(new CustomEvent(event, { detail })),
    };
}
test("a replacement loads paused, seeks before play, and releases its event listeners", async () => {
    const f = fixture();
    const pending = f.start();
    assert.equal(f.calls.length, 1);
    assert.equal((f.calls[0][2] as { autoplay: boolean }).autoplay, false);
    assert.equal((f.calls[0][2] as { format: string }).format, "mp3");
    f.emit("load", { durationSec: 240 });
    await pending;
    assert.deepEqual(f.calls.slice(1), [["seek", 73.5], ["ready"], ["play"]]);
    assert.equal(f.listeners.size, 0);
});
test("a late load after a changed selection never seeks or plays the new track", async () => {
    const f = fixture();
    const pending = f.start();
    f.retire();
    f.emit("load", { durationSec: 240 });
    await assert.rejects(pending);
    assert.equal(f.calls.length, 1);
    assert.equal(f.listeners.size, 0);
});
test("cancelled loads remove listeners and cannot restart audio", async () => {
    const f = fixture();
    const pending = f.start();
    f.controller.abort();
    await assert.rejects(pending);
    f.emit("load", { durationSec: 240 });
    assert.equal(f.calls.length, 1);
    assert.equal(f.listeners.size, 0);
});
test("a preview or mismatched duration fails without seeking or playing", async () => {
    const f = fixture();
    const pending = f.start();
    f.emit("load", { durationSec: 30 });
    await assert.rejects(pending);
    assert.equal(f.calls.length, 1);
});
test("an error on the replacement settles recovery and does not leave a load listener", async () => {
    const f = fixture();
    const pending = f.start();
    f.emit("loaderror", { error: new Error("network") });
    await assert.rejects(pending);
    assert.equal(f.listeners.size, 0);
});
