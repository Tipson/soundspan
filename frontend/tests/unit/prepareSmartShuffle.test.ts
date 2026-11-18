import assert from "node:assert/strict";
import test from "node:test";
import type { PlaylistDetailResponse } from "../../lib/api";
import type { Track } from "../../lib/audio-state-context";
import type { FiniteQueueAdmissionReference } from "../../lib/audio/recommendationQueueAdmission";
import { prepareSmartShuffle } from "../../features/playlist/lib/prepareSmartShuffle";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";

const candidate = (id: string): Track => ({
    id,
    title: "Same title",
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 180,
});
function snapshot(): PlaylistDetailResponse {
    return {
        id: "playlist-1",
        name: "Mine",
        isOwner: true,
        isPublic: false,
        isHidden: false,
        pendingCount: 0,
        totalItemCount: 3,
        items: ["a", "a", "b"].map((id, i) => ({
            id: `item-${i}`,
            type: "track",
            sort: i,
            track: {
                id,
                title: "Same title",
                duration: 180,
                album: { title: "Album", artist: { name: "Artist" } },
            },
        })),
        pendingTracks: [],
    };
}
const base = {
    playlistId: "playlist-1",
    sessionId: "session-1",
    seed: 123,
    isCurrent: () => true,
    loadSnapshot: async () => snapshot(),
    loadPool: async () => [
        candidate("denied-alias"),
        candidate("allowed"),
        candidate("blocked-artist"),
    ],
    admit: async (refs: readonly FiniteQueueAdmissionReference[]) => ({
        status: "ready" as const,
        response: {
            version: 1 as const,
            appliesTo: "recommended_future" as const,
            decisions: refs.map((r) => ({
                ...r,
                state:
                    r.id === "allowed"
                        ? ("allowed" as const)
                        : ("denied" as const),
            })),
        },
    }),
};

test("full owner snapshot plus affirmative exact admission injects only allowed rows, never writes original playlist", async () => {
    const source = snapshot(),
        before = JSON.stringify(source);
    const result = await prepareSmartShuffle({
        ...base,
        loadSnapshot: async () => source,
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(
        result.tracks.map((t) => t.id),
        ["a", "a", "b", "allowed"],
    );
    assert.deepEqual(
        result.tracks.slice(0, 3).map((t) => t.playlistItemId),
        ["item-0", "item-1", "item-2"],
    );
    assert.equal(JSON.stringify(source), before);
});
for (const kind of ["owner", "truncated", "count", "duplicate-item"] as const) {
    test(`reject incomplete/unowned snapshot: ${kind}`, async () => {
        const source = snapshot();
        if (kind === "owner") source.isOwner = false;
        if (kind === "truncated") source.truncated = true;
        if (kind === "count") source.totalItemCount = 4;
        if (kind === "duplicate-item") source.items[1].id = source.items[0].id;
        let poolReads = 0;
        const result = await prepareSmartShuffle({
            ...base,
            loadSnapshot: async () => source,
            loadPool: async () => {
                poolReads++;
                return [];
            },
        });
        assert.equal(result.status, "invalid-snapshot");
        assert.equal(poolReads, 0);
    });
}
test("provider/admission outage and old exact-only server keep original own occurrences", async () => {
    for (const override of [
        {
            loadPool: async () => {
                throw new Error("fixture provider outage");
            },
        },
        { admit: async () => ({ status: "unavailable" as const }) },
        { admit: async () => ({ status: "legacy_exact" as const }) },
    ]) {
        const result = await prepareSmartShuffle({ ...base, ...override });
        assert.equal(result.status, "ready");
        assert.deepEqual(
            result.tracks.map((t) => t.id),
            ["a", "a", "b"],
        );
        assert.ok(
            result.tracks.every(
                (track) => track.smartShuffle?.enabled === false,
            ),
        );
    }
});
test("late owner/queue edit and disable supersede held pool without committing", async () => {
    let active = true,
        finish!: (value: Track[]) => void;
    const pending = prepareSmartShuffle({
        ...base,
        isCurrent: () => active,
        loadPool: () => new Promise<Track[]>((resolve) => (finish = resolve)),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof finish, "function");
    active = false;
    finish([candidate("allowed")]);
    assert.equal((await pending).status, "superseded");
});
test("offline uses only a complete owner cached snapshot and does not call providers", async () => {
    let network = 0;
    const result = await prepareSmartShuffle({
        ...base,
        online: false,
        cachedSnapshot: snapshot(),
        loadSnapshot: async () => {
            network++;
            return snapshot();
        },
        loadPool: async () => {
            network++;
            return [];
        },
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(
        result.tracks.map((t) => t.id),
        ["a", "a", "b"],
    );
    assert.equal(network, 0);
});

for (const provider of ["vk", "yandex"] as const) {
    test(`existing ${provider} playlist recording snapshot retains exact metadata and duplicate item positions`, async () => {
        const native = toMusicSourcePlaybackTrack({
            provider,
            id: provider === "vk" ? "-12_34" : "123",
            title: "Native title",
            artists: ["Artist", "Second"],
            duration: 180,
            preview: false,
            contentVersion: "explicit",
        });
        // Exact server native wire extends the legacy playlist-track TS shape.
        const source = {
            ...snapshot(),
            totalItemCount: 2,
            items: [0, 1].map((index) => ({
                id: `native-item-${index}`,
                type: "track",
                sort: index,
                track: native,
                playback: { isPlayable: true },
            })),
        } as unknown as PlaylistDetailResponse;
        const result = await prepareSmartShuffle({
            ...base,
            loadSnapshot: async () => source,
            loadPool: async () => [],
        });
        assert.equal(result.status, "ready");
        assert.deepEqual(
            result.tracks.map((track) => track.musicSourceRecording),
            [native.musicSourceRecording, native.musicSourceRecording],
        );
        assert.deepEqual(
            result.tracks.map((track) => track.playlistItemId),
            ["native-item-0", "native-item-1"],
        );
        assert.ok(
            result.tracks.every(
                (track) =>
                    track.id === native.id &&
                    track.youtubeVideoId === undefined,
            ),
        );
    });
}

for (const count of [100, 101, 5000]) {
    test(`full own${count} is rejected before the pool, never truncated into a smart queue`, async () => {
        const source = snapshot();
        source.totalItemCount = count;
        source.items = Array.from({ length: count }, (_, index) => ({
            ...source.items[0],
            id: `item-${index}`,
            sort: index,
        }));
        const before = JSON.stringify(source);
        let poolReads = 0;
        const result = await prepareSmartShuffle({
            ...base,
            loadSnapshot: async () => source,
            loadPool: async () => {
                poolReads++;
                return [];
            },
        });
        assert.equal(result.status, "queue-limit");
        assert.deepEqual(result.tracks, []);
        assert.equal(poolReads, 0);
        assert.equal(JSON.stringify(source), before);
    });
}
