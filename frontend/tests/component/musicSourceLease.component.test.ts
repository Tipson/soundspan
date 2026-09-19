import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createPlaybackSourceLeaseController } from "../../components/player/hooks/playbackSourceLeaseController";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";

let calls = 0;
let deviceCopy = false;
let auth = new AbortController();
let resolvePlayback = async (_candidate: unknown, _signal: AbortSignal) =>
    "/api/music-sources/leases/owned/stream";
mock.module("../../lib/api", {
    namedExports: {
        api: {
            getMusicSourceStreamUrl: () =>
                "/api/music-sources/recordings/vk/1_2/stream",
            resolveMusicSourcePlayback: (
                candidate: unknown,
                signal: AbortSignal,
            ) => {
                calls++;
                return resolvePlayback(candidate, signal);
            },
        },
    },
});
mock.module("../../lib/auth-runtime-generation", {
    namedExports: { getAuthRuntimeLease: () => ({ signal: auth.signal }) },
});
mock.module("../../features/device-offline/playbackResolver", {
    namedExports: {
        hasDeviceOfflinePlaybackCopy: () => deviceCopy,
        acquireDeviceOfflinePlaybackSource: async () => {
            if (deviceCopy) return { url: "blob:device", release() {} };
            throw new Error("No device copy");
        },
    },
});
const track = toMusicSourcePlaybackTrack({
    provider: "vk",
    id: "1_2",
    title: "Song",
    artists: ["Artist"],
    duration: 180,
    contentVersion: "unknown",
    preview: false,
});
const flush = () => new Promise((r) => setImmediate(r));
test("a downloaded service track plays its local bytes without resolving the provider", async () => {
    const { startTrackPlaybackSourceLease } =
        await import("../../components/player/hooks/startTrackPlaybackSourceLease");
    deviceCopy = true;
    calls = 0;
    const urls: string[] = [];
    const controller = createPlaybackSourceLeaseController();
    startTrackPlaybackSourceLease({
        controller,
        track,
        networkUrl: "wrong",
        isCurrent: () => true,
        onReady: (url) => urls.push(url),
        onError: (error) => assert.fail(String(error)),
    });
    await flush();
    assert.equal(calls, 0);
    assert.deepEqual(urls, ["blob:device"]);
    deviceCopy = false;
    controller.release();
});

test("selected service recording uses its private lease without loading a library URL", async () => {
    const { startTrackPlaybackSourceLease } =
        await import("../../components/player/hooks/startTrackPlaybackSourceLease");
    calls = 0;
    const urls: string[] = [],
        errors: unknown[] = [];
    const controller = createPlaybackSourceLeaseController();
    startTrackPlaybackSourceLease({
        controller,
        track,
        networkUrl: "/api/library/wrong",
        isCurrent: () => true,
        onReady: (url) => urls.push(url),
        onError: (e) => errors.push(e),
    });
    await flush();
    assert.equal(calls, 1);
    assert.deepEqual(urls, ["/api/music-sources/leases/owned/stream"]);
    assert.deepEqual(errors, []);
    controller.release();
});
test("device-only queue never contacts a service catalog", async () => {
    const { startTrackPlaybackSourceLease } =
        await import("../../components/player/hooks/startTrackPlaybackSourceLease");
    calls = 0;
    const errors: unknown[] = [];
    const controller = createPlaybackSourceLeaseController();
    startTrackPlaybackSourceLease({
        controller,
        track: { ...track, playbackSourcePolicy: "device-only" },
        networkUrl: "/api/library/wrong",
        isCurrent: () => true,
        onReady: () => assert.fail("No local copy"),
        onError: (e) => errors.push(e),
    });
    await flush();
    assert.equal(calls, 0);
    assert.equal(errors.length, 1);
    controller.release();
});
test("account switch fences a late provider result", async () => {
    const { startTrackPlaybackSourceLease } =
        await import("../../components/player/hooks/startTrackPlaybackSourceLease");
    auth = new AbortController();
    let finish!: (url: string) => void;
    resolvePlayback = () =>
        new Promise((r) => {
            finish = r;
        });
    const urls: string[] = [];
    const controller = createPlaybackSourceLeaseController();
    startTrackPlaybackSourceLease({
        controller,
        track,
        networkUrl: "wrong",
        isCurrent: () => true,
        onReady: (url) => urls.push(url),
        onError: () => {},
    });
    await flush();
    auth.abort();
    finish("late");
    await flush();
    assert.deepEqual(urls, []);
    controller.release();
});
