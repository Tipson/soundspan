import assert from "node:assert/strict";
import test from "node:test";
import {
    buildOriginalRadioContinuationPath,
    collectOriginalRadioContinuation,
} from "../../lib/radio/originalRadioContinuation";

const origin = { kind: "track", source: "youtube", id: "AAAAAAAAAAA" } as const;
const row = (id: string, source = "library", videoId?: string) => ({
    id,
    title: id,
    duration: 180,
    trackNo: null,
    artist: { id: null, name: "Artist" },
    album: { id: null, title: "Album", coverArt: null },
    source,
    provider: { tidalTrackId: null, youtubeVideoId: videoId ?? null },
    ...(videoId ? { youtubeVideoId: videoId } : {}),
});
const response = (tracks: unknown[]) => ({
    tracks,
    radioOrigin: origin,
    generationId: "generation-1",
    nextCursor: 4,
    degraded: false,
    degradedSources: [],
});

test("original radio request keeps four station kinds and only its strict query keys", () => {
    const cases = [
        [origin, "youtube", "AAAAAAAAAAA"],
        [
            { kind: "track", source: "library", id: "local-seed" },
            "vibe",
            "local-seed",
        ],
        [
            { kind: "artist", source: "library", id: "artist-seed" },
            "artist",
            "artist-seed",
        ],
        [
            { kind: "artist", source: "discovery", name: "Ибрагим Маалуф" },
            "artist-name",
            "Ибрагим Маалуф",
        ],
    ] as const;
    for (const [radioOrigin, type, value] of cases) {
        const url = new URL(
            buildOriginalRadioContinuationPath(
                radioOrigin,
                [],
                4,
                25,
                "session-1",
            ),
            "https://fixture.test",
        );
        assert.equal(url.pathname, "/personalized/radio");
        assert.equal(url.searchParams.get("type"), type);
        assert.equal(url.searchParams.get("value"), value);
        assert.deepEqual([...url.searchParams.keys()].sort(), [
            "cursor",
            "limit",
            "sessionId",
            "type",
            "value",
        ]);
    }
});

test("request excludes bounded mixed-source identities and normalizes numeric controls", () => {
    const queue = Array.from({ length: 85 }, (_, index) => ({
        id: `local-${index}`,
    }));
    const url = new URL(
        buildOriginalRadioContinuationPath(
            origin,
            [...queue, { id: "yt:BBBBBBBBBBB", youtubeVideoId: "BBBBBBBBBBB" }],
            Infinity,
            NaN,
            "session-1",
        ),
        "https://fixture.test",
    );
    const exclusions = url.searchParams.get("exclude")!.split(",");
    assert.equal(exclusions.length, 80);
    assert.equal(exclusions[0], "library:local-6");
    assert.equal(exclusions.at(-1), "yt:BBBBBBBBBBB");
    assert.equal(url.searchParams.get("cursor"), "0");
    assert.equal(url.searchParams.get("limit"), "25");
});

test("collector preserves server order, original seed and lineage across mixed sources", () => {
    const tracks = collectOriginalRadioContinuation(
        response([
            row("local-1"),
            row("yt:BBBBBBBBBBB", "youtube", "BBBBBBBBBBB"),
            row("local-2"),
        ]),
        [],
        origin,
        25,
        "session-1",
    );
    assert.deepEqual(
        tracks.map((track) => track.id),
        ["local-1", "yt:BBBBBBBBBBB", "local-2"],
    );
    assert.ok(
        tracks.every(
            (track) =>
                track.recommendationGenerationId === "generation-1" &&
                track.recommendationSessionId === "session-1",
        ),
    );
    assert.ok(
        tracks.every(
            (track) =>
                JSON.stringify(track.radioOrigin) === JSON.stringify(origin),
        ),
    );
    assert.equal(tracks[0].source, "local");
    assert.equal(tracks[1].youtubeVideoId, "BBBBBBBBBBB");
});

test("collector rejects another station, malformed metadata and retired sources", () => {
    assert.deepEqual(
        collectOriginalRadioContinuation(
            {
                ...response([row("local")]),
                radioOrigin: { ...origin, id: "CCCCCCCCCCC" },
            },
            [],
            origin,
            25,
            "session-1",
        ),
        [],
    );
    const tracks = collectOriginalRadioContinuation(
        response([
            null,
            row("tidal:42", "tidal"),
            { ...row("bad-duration"), duration: NaN },
            { ...row("bad-provider", "youtube", "short") },
            { ...row("conflict", "library", "BBBBBBBBBBB") },
            row("fresh"),
        ]),
        [],
        origin,
        25,
        "session-1",
    );
    assert.deepEqual(
        tracks.map((track) => track.id),
        ["fresh"],
    );
});

test("collector excludes queued aliases and duplicate rows without changing order", () => {
    const tracks = collectOriginalRadioContinuation(
        response([
            row("yt:BBBBBBBBBBB", "youtube", "BBBBBBBBBBB"),
            row("local-1"),
            row("local-1"),
            row("local-2"),
        ]),
        [{ id: "radio:BBBBBBBBBBB", youtubeVideoId: "BBBBBBBBBBB" }],
        origin,
        25,
        "session-1",
    );
    assert.deepEqual(
        tracks.map((track) => track.id),
        ["local-1", "local-2"],
    );
    assert.deepEqual(
        collectOriginalRadioContinuation(
            response([row("fresh")]),
            [],
            origin,
            0,
            "session-1",
        ),
        [],
    );
});

test("collector rejects conflicting legacy radio IDs and accepts matching aliases", () => {
    const tracks = collectOriginalRadioContinuation(
        response([
            row("radio:CCCCCCCCCCC", "youtube", "BBBBBBBBBBB"),
            row("yt:CCCCCCCCCCC", "youtube", "BBBBBBBBBBB"),
            row("radio:DDDDDDDDDDD", "youtube", "DDDDDDDDDDD"),
        ]),
        [],
        origin,
        25,
        "session-1",
    );
    assert.deepEqual(
        tracks.map((track) => track.id),
        ["yt:DDDDDDDDDDD"],
    );
});

test("collector strips source internals and does not decorate an empty exhausted station", () => {
    const [track] = collectOriginalRadioContinuation(
        response([
            {
                ...row("fresh"),
                filePath: "/private",
                token: "secret",
                radioOrigin: {
                    kind: "artist",
                    source: "discovery",
                    name: "Wrong",
                },
            },
        ]),
        [],
        origin,
        25,
        "session-1",
    );
    assert.equal("filePath" in track, false);
    assert.equal("token" in track, false);
    assert.deepEqual(track.radioOrigin, origin);
    assert.deepEqual(
        collectOriginalRadioContinuation(
            response([]),
            [],
            origin,
            25,
            "session-1",
        ),
        [],
    );
});
