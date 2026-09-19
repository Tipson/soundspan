import assert from "node:assert/strict";
import test from "node:test";
import { ContinuousAudioEngine } from "../../lib/audio-engine/continuousAudioEngine";
import type {
    AudioEngine,
    AudioEngineEventType,
} from "../../lib/audio-engine/types";
import type { ContinuousAudioSource } from "../../lib/audio-engine/continuousAudioBuffer";

const recording = (url: string): ContinuousAudioSource => ({
    id: url,
    url,
    blob: new Blob(["audio"]),
    mime: "audio/mpeg",
    durationSec: 100,
});
function harness(prepare = async (url: string) => recording(url)) {
    const events = new Map<string, Set<(payload: unknown) => void>>();
    const loads: Array<{
        url: string;
        autoplay?: boolean;
        startTimeSec?: number;
    }> = [];
    let position = 0,
        playing = false,
        plays = 0,
        stops = 0;
    const base = {
        load: (
            source: { url: string },
            options: { autoplay?: boolean; startTimeSec?: number },
        ) => {
            loads.push({
                url: source.url,
                autoplay: options.autoplay,
                startTimeSec: options.startTimeSec,
            });
        },
        play: () => {
            plays++;
            playing = true;
        },
        pause: () => {
            playing = false;
        },
        stop: () => {
            playing = false;
            stops++;
            events.get("stop")?.forEach((fn) => fn(undefined));
        },
        seek: (value: number) => {
            position = value;
        },
        getCurrentTime: () => position,
        getDuration: () => 999,
        isPlaying: () => playing,
        setVolume: () => {},
        setMuted: () => {},
        on: (event: AudioEngineEventType, fn: (payload: unknown) => void) => {
            if (!events.has(event)) events.set(event, new Set());
            events.get(event)!.add(fn);
        },
        off: (event: AudioEngineEventType, fn: (payload: unknown) => void) => {
            events.get(event)?.delete(fn);
        },
    } as unknown as AudioEngine;
    let timeline: any;
    const engine = new ContinuousAudioEngine({
        base,
        prepare: (s, signal) =>
            prepare(s.url).then((result) => {
                signal.throwIfAborted();
                return result;
            }),
        createTimeline: (initial, callbacks) => {
            let current = { ...initial, startSec: 0, endSec: 100 },
                next: ContinuousAudioSource | null = null;
            timeline = {
                url: "blob:timeline",
                get current() {
                    return current;
                },
                pump: async () => {},
                seek: async () => {},
                dispose: () => {},
                stage: (source: ContinuousAudioSource) => {
                    next = source;
                    queueMicrotask(() => callbacks.onNextReady(source.id));
                },
                cancel: (id: string) => {
                    if (next?.id === id) next = null;
                },
                promote: () => {
                    const ended = current.id;
                    current = { ...next!, startSec: 100, endSec: 200 };
                    next = null;
                    position = 100.2;
                    callbacks.onBoundary(ended);
                },
            };
            return timeline;
        },
    });
    return {
        engine,
        loads,
        get plays() {
            return plays;
        },
        get stops() {
            return stops;
        },
        get timeline() {
            return timeline;
        },
        setPosition: (p: number) => {
            position = p;
        },
        emit: (event: string, payload: unknown) =>
            events.get(event)?.forEach((fn) => fn(payload)),
    };
}

test("a prepared natural handoff adopts the playing timeline without reloading native audio", async () => {
    const h = harness();
    await h.engine.load("blob:a", { autoplay: true });
    const lease = h.engine.preload("blob:b")!;
    assert.deepEqual(await lease.result, { state: "ready" });
    let ended = 0,
        loaded = 0;
    h.engine.on("end", () => {
        ended++;
        void h.engine.load("blob:b", { autoplay: true });
    });
    h.engine.on("load", () => loaded++);
    h.timeline.promote();
    await Promise.resolve();
    assert.equal(ended, 1);
    assert.equal(loaded, 1);
    assert.equal(h.loads.length, 1);
    assert.ok(Math.abs(h.engine.getCurrentTime() - 0.2) < 0.001);
    assert.equal(h.engine.getDuration(), 100);
    h.engine.destroy();
});

test("pause while source preparation is pending remains paused when preparation completes", async () => {
    let resolve!: (source: ContinuousAudioSource) => void;
    const h = harness(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const pending = h.engine.load("blob:a", { autoplay: true });
    h.engine.pause();
    resolve(recording("blob:a"));
    await pending;
    assert.equal(h.loads[0].autoplay, false);
    h.engine.destroy();
});

test("next-track preload started during initial preparation joins the continuous timeline", async () => {
    let finish!: (source: ContinuousAudioSource) => void;
    const h = harness((url) =>
        url === "blob:a"
            ? new Promise((resolve) => {
                  finish = resolve;
              })
            : Promise.resolve(recording(url)),
    );
    const loading = h.engine.load("blob:a", { autoplay: true });
    const lease = h.engine.preload("blob:b");
    assert.ok(lease, "pending continuous load must own the next-track lease");
    finish(recording("blob:a"));
    await loading;
    assert.deepEqual(await lease.result, { state: "ready" });
    h.engine.on("end", () => {
        void h.engine.load("blob:b", { autoplay: true });
    });
    h.timeline.promote();
    await Promise.resolve();
    assert.equal(h.loads.length, 1);
    assert.equal(h.timeline.current.url, "blob:b");
    h.engine.destroy();
});

test("stop invalidates an unresolved load and cannot restart it later", async () => {
    let resolve!: (source: ContinuousAudioSource) => void;
    const h = harness(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const pending = h.engine.load("blob:a", { autoplay: true });
    h.engine.stop();
    resolve(recording("blob:a"));
    await pending;
    assert.equal(h.loads.length, 0);
    h.engine.destroy();
});

test("a cancelled preload never becomes staged after its local read completes", async () => {
    let resolve!: (source: ContinuousAudioSource) => void;
    const h = harness((url) =>
        url === "blob:a"
            ? Promise.resolve(recording(url))
            : new Promise((r) => {
                  resolve = r;
              }),
    );
    await h.engine.load("blob:a");
    const lease = h.engine.preload("blob:b")!;
    lease.cancel();
    resolve(recording("blob:b"));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(await lease.result, { state: "cancelled" });
    h.engine.destroy();
});

test("play during asynchronous preparation records intent without reviving the old native source", async () => {
    let resolve!: (source: ContinuousAudioSource) => void;
    const h = harness(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const pending = h.engine.load("blob:a", { autoplay: false });
    h.engine.play();
    assert.equal(h.plays, 0);
    resolve(recording("blob:a"));
    await pending;
    assert.equal(h.loads[0].autoplay, true);
    h.engine.destroy();
});

test("a superseded seek never overwrites the most recent seek position", async () => {
    const h = harness();
    await h.engine.load("blob:a");
    const finishes: Array<() => void> = [];
    h.timeline.seek = () =>
        new Promise<void>((resolve) => finishes.push(resolve));
    const old = h.engine.seek(5),
        latest = h.engine.seek(60);
    finishes[1]();
    await latest;
    finishes[0]();
    await old;
    assert.equal(h.engine.getCurrentTime(), 60);
    h.engine.destroy();
});

test("initial resume position reaches the native engine before autoplay", async () => {
    const h = harness();
    await h.engine.load("blob:a", { autoplay: true, startTimeSec: 70 });
    assert.equal(h.loads[0].startTimeSec, 70);
    h.engine.destroy();
});

test("network loads keep the synchronous native path without an extra stop or local read", () => {
    const h = harness(async () => {
        throw new Error("Network must not use local preparation");
    });
    void h.engine.load("https://example.com/audio", { autoplay: true });
    assert.equal(h.loads[0]?.url, "https://example.com/audio");
    assert.equal(h.stops, 0);
    h.engine.destroy();
});

test("an internal load reset does not publish a user-facing stop", async () => {
    const h = harness();
    let stopped = 0;
    h.engine.on("stop", () => stopped++);
    await h.engine.load("blob:a", { autoplay: true });
    assert.equal(stopped, 0);
    h.engine.stop();
    assert.equal(stopped, 1);
    h.engine.destroy();
});

test("seek-then-play waits for local refill and honors a newer pause", async () => {
    const h = harness();
    await h.engine.load("blob:a", { autoplay: false });
    let finish!: () => void;
    h.timeline.seek = () =>
        new Promise<void>((resolve) => {
            finish = resolve;
        });
    const seeking = h.engine.seek(60);
    h.engine.play();
    assert.equal(h.plays, 0);
    finish();
    await seeking;
    assert.equal(h.plays, 1);
    assert.equal(h.engine.getCurrentTime(), 60);
    const pausedSeek = h.engine.seek(5);
    h.engine.pause();
    finish();
    await pausedSeek;
    assert.equal(h.plays, 1);
    assert.equal(h.engine.isPlaying(), false);
    h.engine.destroy();
});

test("repeat-one replaces a prepared different track and repeats the current source across three boundaries", async () => {
    const h = harness();
    await h.engine.load("blob:a", { autoplay: true });
    await h.engine.preload("blob:b")!.result;
    h.engine.setRepeatCurrent(true);
    assert.equal(h.engine.preload("blob:b"), null);
    let ends = 0;
    h.engine.on("end", () => {
        ends++;
        void h.engine.seek(0);
        h.engine.play();
    });
    for (let cycle = 0; cycle < 3; cycle++) {
        h.timeline.promote();
        await Promise.resolve();
        assert.equal(h.timeline.current.url, "blob:a");
        assert.equal(h.engine.hasTrackEnded(), false);
    }
    assert.equal(ends, 3);
    assert.equal(h.loads.length, 1);
    h.engine.destroy();
});

test("disabling repeat-one permits the caller-selected next recording", async () => {
    const h = harness();
    h.engine.setRepeatCurrent(true);
    await h.engine.load("blob:a");
    h.engine.setRepeatCurrent(false);
    await h.engine.preload("blob:b")!.result;
    h.timeline.promote();
    assert.equal(h.timeline.current.url, "blob:b");
    h.engine.destroy();
});

test("entering externally controlled playback drops staged next and repeat without changing the current recording", async () => {
    for (const repeat of [false, true]) {
        const h = harness();
        await h.engine.load("blob:a", { autoplay: true });
        if (repeat) h.engine.setRepeatCurrent(true);
        else await h.engine.preload("blob:b")!.result;
        h.setPosition(35);
        h.engine.setContinuousEnabled(false);
        assert.deepEqual(h.loads.at(-1), {
            url: "blob:a",
            autoplay: true,
            startTimeSec: 35,
        });
        await h.engine.load("blob:b", { autoplay: false });
        assert.equal(h.loads.at(-1)?.url, "blob:b");
        assert.equal(h.loads.at(-1)?.autoplay, false);
        h.engine.destroy();
    }
});
