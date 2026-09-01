import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { after, before } from "node:test";
import type { Howl, HowlOptions } from "howler";

type HowlCallback = (...args: unknown[]) => void;

class StubMediaElement extends EventTarget {
    ended = false;
    currentTime = 0;
}

class StubHowl {
    static readonly instances: StubHowl[] = [];

    readonly _sounds: Array<{ _node: StubMediaElement }>;
    playCalls = 0;

    private readonly callbacks = new Map<string, Set<HowlCallback>>();
    private readonly options: HowlOptions;

    constructor(options: HowlOptions) {
        this.options = options;
        this._sounds = [{ _node: new StubMediaElement() }];
        StubHowl.instances.push(this);
    }

    finishLoad(): void {
        this.options.onload?.(1);
    }

    failLoad(error: unknown = new Error("load failed")): void {
        this.options.onloaderror?.(1, error);
    }

    failPlay(error: unknown = new Error("play failed")): void {
        this.options.onplayerror?.(1, error);
    }

    finishPlay(): void {
        this.options.onplay?.(1);
    }

    finishPause(): void {
        this.options.onpause?.(1);
    }

    finishStop(): void {
        this.options.onstop?.(1);
    }

    finishEnd(): void {
        this.options.onend?.(1);
    }

    finishSeek(): void {
        this.options.onseek?.(1);
    }

    duration(): number {
        return 240;
    }

    fade(): this {
        return this;
    }

    on(event: string, callback: HowlCallback): this {
        const callbacks = this.callbacks.get(event) ?? new Set();
        callbacks.add(callback);
        this.callbacks.set(event, callbacks);
        return this;
    }

    once(event: string, callback: HowlCallback): this {
        return this.on(event, callback);
    }

    pause(): this {
        return this;
    }

    play(): number {
        this.playCalls += 1;
        return this.playCalls;
    }

    playing(): boolean {
        return false;
    }

    seek(): number {
        return 0;
    }

    stop(): this {
        return this;
    }

    unload(): null {
        return null;
    }

    volume(): number {
        return 1;
    }
}

const require = createRequire(import.meta.url);
const howlerModule = require("howler") as { Howl: typeof Howl };
const OriginalHowl = howlerModule.Howl;
const originalMediaElement = Object.getOwnPropertyDescriptor(
    globalThis,
    "HTMLMediaElement",
);

howlerModule.Howl = StubHowl as unknown as typeof Howl;
let HowlerEngine: (typeof import("../../lib/howler-engine"))["HowlerEngine"];

before(async () => {
    Object.defineProperty(globalThis, "HTMLMediaElement", {
        configurable: true,
        value: StubMediaElement,
    });
    ({ HowlerEngine } = await import("../../lib/howler-engine"));
});

after(() => {
    howlerModule.Howl = OriginalHowl;
    if (originalMediaElement) {
        Object.defineProperty(
            globalThis,
            "HTMLMediaElement",
            originalMediaElement,
        );
    } else {
        Reflect.deleteProperty(globalThis, "HTMLMediaElement");
    }
});

test("notifyTrackEnded re-emits a consumed end when the media node ended", (t) => {
    const engine = new HowlerEngine();
    t.after(() => engine.destroy());
    engine.load("https://stream.example/ended.flac");
    const howl = StubHowl.instances.at(-1);
    assert.ok(howl);
    howl._sounds[0]._node.ended = true;

    let endEvents = 0;
    engine.on("end", () => {
        endEvents += 1;
    });

    assert.equal(engine.getState().isPlaying, false);
    engine.notifyTrackEnded();
    assert.equal(endEvents, 1);
});

test("notifyTrackEnded does not emit before the media node ends", (t) => {
    const engine = new HowlerEngine();
    t.after(() => engine.destroy());
    engine.load("https://stream.example/playing.flac");
    const howl = StubHowl.instances.at(-1);
    assert.ok(howl);
    howl._sounds[0]._node.ended = false;

    let endEvents = 0;
    engine.on("end", () => {
        endEvents += 1;
    });

    engine.notifyTrackEnded();
    assert.equal(endEvents, 0);
});

test("preloaded promotion emits load and autoplays after only a microtask flush", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const engine = new HowlerEngine();
    t.after(() => engine.destroy());
    const src = "https://stream.example/preloaded.flac";

    engine.preload(src, "flac");
    const preloadedHowl = StubHowl.instances.at(-1);
    assert.ok(preloadedHowl);
    preloadedHowl.finishLoad();

    let loadEvents = 0;
    engine.load(src, true, "flac");
    engine.on("load", () => {
        loadEvents += 1;
    });

    assert.equal(loadEvents, 0);
    assert.equal(preloadedHowl.playCalls, 0);
    await Promise.resolve();
    assert.equal(loadEvents, 1);
    assert.equal(preloadedHowl.playCalls, 1);
});

test("late callbacks from a superseded track cannot fail or autoplay the replacement", (t) => {
    const engine = new HowlerEngine();
    t.after(() => engine.destroy());
    let loadEvents = 0;
    let loadErrors = 0;
    let playErrors = 0;
    let transportEvents = 0;
    engine.on("load", () => {
        loadEvents += 1;
    });
    engine.on("loaderror", () => {
        loadErrors += 1;
    });
    engine.on("playerror", () => {
        playErrors += 1;
    });
    for (const event of ["play", "pause", "stop", "end", "seek"] as const) {
        engine.on(event, () => {
            transportEvents += 1;
        });
    }

    engine.load("https://stream.example/first.flac", true, "flac");
    const superseded = StubHowl.instances.at(-1);
    assert.ok(superseded);

    engine.load("https://stream.example/replacement.flac", true, "flac");
    const replacement = StubHowl.instances.at(-1);
    assert.ok(replacement);
    assert.notEqual(replacement, superseded);

    superseded.finishLoad();
    superseded.failLoad();
    superseded.failPlay();
    superseded.finishPlay();
    superseded.finishPause();
    superseded.finishStop();
    superseded.finishEnd();
    superseded.finishSeek();

    assert.equal(loadEvents, 0);
    assert.equal(loadErrors, 0);
    assert.equal(playErrors, 0);
    assert.equal(transportEvents, 0);
    assert.equal(superseded.playCalls, 0);
    assert.equal(
        engine.getState().currentSrc,
        "https://stream.example/replacement.flac",
    );

    replacement.finishLoad();
    assert.equal(loadEvents, 1);
    assert.equal(replacement.playCalls, 1);
});
