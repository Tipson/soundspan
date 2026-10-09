import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";

const state = {
    createCalls: [] as Array<Record<string, unknown>>,
    getCalls: [] as string[],
    playCalls: [] as Array<{ count: number; startIndex: number }>,
    pushCalls: [] as string[],
    errorToasts: [] as string[],
    successToasts: [] as string[],
    trackCount: 12,
    failCreate: false,
    getGate: null as Promise<void> | null,
};

mock.module("lucide-react", {
    namedExports: {
        Shuffle: () => React.createElement("svg"),
    },
});

const notifier = {
    error: (message: string) => {
        state.errorToasts.push(message);
    },
    stationStarted: (name: string) => {
        state.successToasts.push(name);
    },
};

mock.module("@/lib/api", {
    namedExports: {
        api: {
            createRadioPlaylist: async (input: Record<string, unknown>) => {
                if (state.failCreate) {
                    throw new Error("generation failed");
                }
                state.createCalls.push(input);
                return {
                    playlistId: "generated-42",
                    entries: Array.from(
                        { length: state.trackCount },
                        (_, i) => ({ id: String(i) }),
                    ),
                };
            },
            get: async (path: string) => {
                state.getCalls.push(path);
                if (state.getGate) await state.getGate;
                return {
                    tracks: Array.from(
                        { length: state.trackCount },
                        (_, index) => ({
                            id: `track-${index}`,
                            title: `Track ${index}`,
                        }),
                    ),
                };
            },
        },
    },
});

mock.module("@/utils/shuffle", {
    namedExports: {
        shuffleArray: <T>(values: T[]) => values,
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
        },
    },
});

beforeEach(() => {
    state.createCalls.length = 0;
    state.getCalls.length = 0;
    state.playCalls.length = 0;
    state.pushCalls.length = 0;
    state.errorToasts.length = 0;
    state.successToasts.length = 0;
    state.trackCount = 12;
    state.failCreate = false;
    state.getGate = null;
});

async function loadHelper() {
    const mod = await import("../../lib/radio/openRadioStation");
    const named = mod as unknown as {
        openRadioStation?: (
            station: Record<string, unknown>,
            handlers: Record<string, unknown>,
        ) => Promise<void>;
    };
    const cjsDefault = (
        mod as {
            default?: {
                openRadioStation?: (
                    station: Record<string, unknown>,
                    handlers: Record<string, unknown>,
                ) => Promise<void>;
            };
        }
    ).default;
    const openRadioStation =
        named.openRadioStation ?? cjsDefault?.openRadioStation;
    assert.ok(openRadioStation, "openRadioStation export is available");
    return openRadioStation;
}

const handlers = {
    push: (path: string) => state.pushCalls.push(path),
    playTracks: (tracks: unknown[], startIndex: number) =>
        state.playCalls.push({ count: tracks.length, startIndex }),
    notifier,
};

test("filtered stations create a generated playlist and navigate", async () => {
    const openRadioStation = await loadHelper();
    await openRadioStation(
        {
            id: "genre-rock",
            name: "Rock",
            filter: { type: "genre", value: "rock" },
            minTracks: 15,
        },
        handlers,
    );

    assert.deepEqual(state.createCalls, [
        { filter: { type: "genre", value: "rock" } },
    ]);
    assert.deepEqual(state.pushCalls, ["/playlist/generated-42"]);
    assert.equal(state.playCalls.length, 0);
    assert.deepEqual(state.getCalls, []);
});

test("Shuffle All fetches tracks and starts instant playback", async () => {
    const openRadioStation = await loadHelper();
    await openRadioStation(
        {
            id: "all",
            name: "Shuffle All",
            filter: { type: "all" },
            minTracks: 10,
        },
        handlers,
    );

    assert.equal(state.createCalls.length, 0);
    assert.equal(state.pushCalls.length, 0);
    assert.deepEqual(state.playCalls, [{ count: 12, startIndex: 0 }]);
    assert.match(state.getCalls[0] ?? "", /^\/library\/radio\?/);
    assert.equal(state.successToasts.length, 1);
});

test("Shuffle All refuses to play below the station minimum", async () => {
    const openRadioStation = await loadHelper();
    state.trackCount = 3;
    await openRadioStation(
        {
            id: "all",
            name: "Shuffle All",
            filter: { type: "all" },
            minTracks: 10,
        },
        handlers,
    );

    assert.equal(state.playCalls.length, 0);
    assert.equal(state.errorToasts.length, 1);
    assert.match(state.errorToasts[0] ?? "", /Недостаточно треков/);
});

test("decade guard accepts only API-valid decades", async () => {
    const { isGeneratedPlaylistDecade } =
        await import("../../lib/radio/openRadioStation");

    for (const valid of [1000, 1700, 1990, 2020, 2090]) {
        assert.equal(isGeneratedPlaylistDecade(valid), true, `${valid}`);
    }
    for (const invalid of [990, 2100, 1995, 2020.5, Number.NaN]) {
        assert.equal(isGeneratedPlaylistDecade(invalid), false, `${invalid}`);
    }
});

test("generation failures surface a toast and resolve", async () => {
    const openRadioStation = await loadHelper();
    state.failCreate = true;
    await openRadioStation(
        {
            id: "decade-1990",
            name: "90s",
            filter: { type: "decade", value: "1990" },
        },
        handlers,
    );

    assert.equal(state.pushCalls.length, 0);
    assert.equal(state.playCalls.length, 0);
    assert.deepEqual(state.errorToasts, ["Не удалось открыть радиостанцию"]);
});

test("empty generated stations show feedback instead of opening a dead playlist", async () => {
    const openRadioStation = await loadHelper();
    state.trackCount = 0;
    await openRadioStation(
        { id: "empty", name: "Empty", filter: { type: "discovery" } },
        handlers,
    );
    assert.deepEqual(state.pushCalls, []);
    assert.equal(state.errorToasts.length, 1);
});

test("Shuffle All discards its deferred response after a newer playback action", async () => {
    const openRadioStation = await loadHelper();
    const { recordExplicitPlaybackPause } =
        await import("../../lib/audio-engine/playbackAdvanceOrigin");
    let release!: () => void;
    state.getGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const pending = openRadioStation(
        { id: "all", name: "All", filter: { type: "all" } },
        handlers,
    );
    recordExplicitPlaybackPause();
    release();
    await pending;
    assert.deepEqual(state.playCalls, []);
    assert.deepEqual(state.successToasts, []);
});
