import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createPlaybackSourceLeaseController,
    type PlaybackSourceLease,
} from "../../components/player/hooks/playbackSourceLeaseController";

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function lease(url: string, onRelease: () => void): PlaybackSourceLease {
    return { url, release: onRelease };
}

test("acquire exposes the selected URL while the request generation stays current", async () => {
    const controller = createPlaybackSourceLeaseController();
    const observed = { signal: null as AbortSignal | null };

    const url = await controller.acquire(
        async (signal) => {
            observed.signal = signal;
            return lease("blob:current", () => undefined);
        },
        () => true,
    );

    assert.equal(url, "blob:current");
    assert.equal(observed.signal?.aborted, false);
});

test("a newer acquire aborts and releases a late lease from the prior generation", async () => {
    const controller = createPlaybackSourceLeaseController();
    const first = deferred<PlaybackSourceLease>();
    const firstRequest = { signal: null as AbortSignal | null };
    let firstReleases = 0;
    let secondReleases = 0;

    const firstResult = controller.acquire(
        (signal) => {
            firstRequest.signal = signal;
            return first.promise;
        },
        () => true,
    );
    const secondResult = controller.acquire(
        async () => lease("blob:second", () => secondReleases++),
        () => true,
    );

    assert.equal(firstRequest.signal?.aborted, true);
    first.resolve(lease("blob:first", () => firstReleases++));

    assert.equal(await firstResult, null);
    assert.equal(await secondResult, "blob:second");
    assert.equal(firstReleases, 1);
    assert.equal(secondReleases, 0);
});

test("the caller generation guard rejects a late result before engine load", async () => {
    const controller = createPlaybackSourceLeaseController();
    let releases = 0;

    const result = await controller.acquire(
        async () => lease("blob:stale", () => releases++),
        () => false,
    );

    assert.equal(result, null);
    assert.equal(releases, 1);
});

test("release aborts pending work and releases the active lease exactly once", async () => {
    const controller = createPlaybackSourceLeaseController();
    let releases = 0;
    const pending = deferred<PlaybackSourceLease>();
    const pendingRequest = { signal: null as AbortSignal | null };

    assert.equal(
        await controller.acquire(
            async () => lease("blob:active", () => releases++),
            () => true,
        ),
        "blob:active",
    );
    const pendingResult = controller.acquire(
        (signal) => {
            pendingRequest.signal = signal;
            return pending.promise;
        },
        () => true,
    );

    assert.equal(releases, 1);
    controller.release();
    controller.release();
    assert.equal(pendingRequest.signal?.aborted, true);

    pending.resolve(lease("blob:too-late", () => releases++));
    assert.equal(await pendingResult, null);
    assert.equal(releases, 2);
});

test("an error from the active generation reaches the caller", async () => {
    const controller = createPlaybackSourceLeaseController();
    const expected = new Error("storage unavailable");

    await assert.rejects(
        controller.acquire(
            async () => {
                throw expected;
            },
            () => true,
        ),
        expected,
    );
});

test("an AbortError from a retired auth runtime is treated as a stale result", async () => {
    const controller = createPlaybackSourceLeaseController();

    assert.equal(
        await controller.acquire(
            async () => {
                throw new DOMException("Authentication changed", "AbortError");
            },
            () => true,
        ),
        null,
    );
});
