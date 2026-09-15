import assert from "node:assert/strict";
import test from "node:test";
import { observePlaybackDiagnostics } from "../../lib/audio-engine/playbackDiagnosticObserver";
import type { AudioEngine } from "../../lib/audio-engine/types";

test("diagnostic observers wake the durable backlog and sample discrete events, never progress", () => {
    const page = new EventTarget();
    const document = Object.assign(new EventTarget(), {
        visibilityState: "visible" as DocumentVisibilityState,
    });
    const events: string[] = [];
    const handlers = new Map<string, () => void>();
    let wakes = 0;
    let duration = 0;
    const engine = {
        on: (event: string, handler: () => void) =>
            handlers.set(event, handler),
        off: (event: string) => handlers.delete(event),
        getDuration: () => duration,
    } as unknown as AudioEngine;
    const cleanup = observePlaybackDiagnostics({
        engine,
        page,
        document,
        record: (event) => events.push(event),
        wake: () => {
            wakes++;
        },
    });
    assert.equal(
        wakes,
        1,
        "mount flushes a retained backlog without needing new playback",
    );
    assert.equal(handlers.has("timeupdate"), false);
    document.dispatchEvent(new Event("visibilitychange"));
    assert.deepEqual(events, []);
    duration = 180;
    handlers.get("pause")?.();
    handlers.get("end")?.();
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(
        wakes,
        2,
        "hidden transition saves only and does not reset retry budget",
    );
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    page.dispatchEvent(new Event("online"));
    page.dispatchEvent(new Event("pageshow"));
    assert.equal(wakes, 5);
    assert.deepEqual(events, [
        "player.engine_pause",
        "player.track_end",
        "player.visibility_change",
        "player.visibility_change",
    ]);
    cleanup();
    page.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(wakes, 5);
    assert.equal(handlers.size, 0);
});

test("throwing diagnostic sinks cannot interrupt native callbacks", () => {
    const handlers = new Map<string, () => void>();
    const engine = {
        on: (event: string, handler: () => void) =>
            handlers.set(event, handler),
        off: (event: string) => handlers.delete(event),
        getDuration: () => 180,
    } as unknown as AudioEngine;
    const cleanup = observePlaybackDiagnostics({
        engine,
        page: new EventTarget(),
        document: Object.assign(new EventTarget(), {
            visibilityState: "visible" as DocumentVisibilityState,
        }),
        record: () => {
            throw Error("quota");
        },
        wake: () => {
            throw Error("restricted");
        },
    });
    assert.doesNotThrow(() => handlers.get("pause")?.());
    cleanup();
});
