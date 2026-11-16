import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { requestOrderedWaveFeed } from "../../lib/audio/orderedWaveRequest";
import { readOrderedWavePage } from "../../lib/audio/orderedWaveSequence";

const raw = JSON.parse(
    readFileSync(
        new URL("../../../fixtures/ordered-wave-v1.json", import.meta.url),
        "utf8",
    ),
).cases[0].orderedWave;
const base = {
    shelves: { listenAgain: [], quickPicks: [], discovery: [] },
    degraded: false,
    reason: null,
    seedCount: 1,
    generationId: "fixture",
};
const ordered = { ...base, orderedWave: raw };
const page = readOrderedWavePage(ordered)!;
const checkpoint = {
    sequenceId: page.sequenceId,
    nextPosition: 6,
    nextCursor: page.nextCursor,
    tail: page.tail,
};
const path =
    "/personalized/home?surface=wave&sessionId=tab&cursor=7&mode=for-you";
const resetError = () =>
    Object.assign(new Error("reset"), {
        status: 409,
        data: { code: "WAVE_SEQUENCE_RESET" },
    });

test("legacy server never receives opt-in fields", async () => {
    const paths: string[] = [];
    const result = await requestOrderedWaveFeed(
        {
            getOwner: () => 1,
            capabilities: async () => ({}),
            request: async (path) => {
                paths.push(path);
                return base;
            },
        },
        path,
    );
    assert.equal(
        new URL(paths[0], "https://test").searchParams.has(
            "waveSequenceVersion",
        ),
        false,
    );
    assert.equal(result.page, undefined);
});
test("advertisement sends explicit version and resets numeric cursor for the first sequence", async () => {
    const paths: string[] = [];
    const result = await requestOrderedWaveFeed(
        {
            getOwner: () => 1,
            capabilities: async () => ({ orderedWave: { version: 1 } }),
            request: async (path) => {
                paths.push(path);
                return ordered;
            },
        },
        path,
    );
    const params = new URL(paths[0], "https://test").searchParams;
    assert.equal(params.get("waveSequenceVersion"), "1");
    assert.equal(params.get("cursor"), "0");
    assert.equal(params.has("waveSequenceTail"), false);
    assert.deepEqual(
        result.page?.items.map((row) => row.track.id),
        raw.items.map((row: { track: { id: string } }) => row.track.id),
    );
});
test("continuation carries the entire exact checkpoint and checks the returned start", async () => {
    let requested = "";
    const next = structuredClone(raw);
    next.startPosition = 6;
    next.items.forEach((row: { position: number }) => (row.position += 6));
    next.tail.forEach((row: { position: number }) => (row.position += 6));
    const result = await requestOrderedWaveFeed(
        {
            getOwner: () => 1,
            request: async (path) => {
                requested = path;
                return { ...base, orderedWave: next };
            },
        },
        path,
        checkpoint,
    );
    const params = new URL(requested, "https://test").searchParams;
    assert.equal(params.get("waveSequenceCursor"), checkpoint.nextCursor);
    assert.deepEqual(
        JSON.parse(params.get("waveSequenceTail")!),
        checkpoint.tail,
    );
    assert.equal(result.reset, false);
});
test("rejected continuation makes only one fresh reset request", async () => {
    const paths: string[] = [];
    const result = await requestOrderedWaveFeed(
        {
            getOwner: () => 1,
            capabilities: async () => ({ orderedWave: { version: 1 } }),
            request: async (path) => {
                paths.push(path);
                if (paths.length === 1) throw resetError();
                return ordered;
            },
        },
        path,
        checkpoint,
    );
    assert.equal(paths.length, 2);
    const params = new URL(paths[1], "https://test").searchParams;
    assert.equal(params.has("waveSequenceCursor"), false);
    assert.equal(params.get("cursor"), "0");
    assert.equal(result.reset, true);
});
test("a second rejected reset does not create a refill loop", async () => {
    let requests = 0;
    await assert.rejects(
        requestOrderedWaveFeed(
            {
                getOwner: () => 1,
                capabilities: async () => ({ orderedWave: { version: 1 } }),
                request: async () => {
                    requests++;
                    throw resetError();
                },
            },
            path,
            checkpoint,
        ),
    );
    assert.equal(requests, 2);
});
test("explicit flag rollback resets into legacy shelves", async () => {
    const paths: string[] = [];
    const result = await requestOrderedWaveFeed(
        {
            getOwner: () => 1,
            capabilities: async () => ({}),
            request: async (path) => {
                paths.push(path);
                if (paths.length === 1) throw resetError();
                return base;
            },
        },
        path,
        checkpoint,
    );
    assert.equal(paths.length, 2);
    assert.equal(
        new URL(paths[1], "https://test").searchParams.has(
            "waveSequenceVersion",
        ),
        false,
    );
    assert.equal(result.page, undefined);
    assert.equal(result.reset, true);
});
test("unavailable capability after rejection does not silently downgrade", async () => {
    let requests = 0;
    await assert.rejects(
        requestOrderedWaveFeed(
            {
                getOwner: () => 1,
                capabilities: async () => {
                    throw new Error("offline");
                },
                request: async () => {
                    requests++;
                    throw resetError();
                },
            },
            path,
            checkpoint,
        ),
    );
    assert.equal(requests, 1);
});
test("malformed-present data and a mismatched successful continuation fail without retry", async () => {
    for (const response of [{ ...base, orderedWave: null }, ordered]) {
        let requests = 0;
        await assert.rejects(
            requestOrderedWaveFeed(
                {
                    getOwner: () => 1,
                    request: async () => {
                        requests++;
                        return response;
                    },
                },
                path,
                checkpoint,
            ),
        );
        assert.equal(requests, 1);
    }
});
test("auth replacement during discovery never starts the old owner's feed request", async () => {
    let owner = 1,
        requests = 0;
    await assert.rejects(
        requestOrderedWaveFeed(
            {
                getOwner: () => owner,
                capabilities: async () => {
                    owner++;
                    return { orderedWave: { version: 1 } };
                },
                request: async () => {
                    requests++;
                    return ordered;
                },
            },
            path,
        ),
    );
    assert.equal(requests, 0);
});
