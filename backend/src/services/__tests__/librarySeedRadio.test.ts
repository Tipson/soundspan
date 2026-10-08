import type { Request, Response } from "express";

const mockLoadVibeRadioCandidateIds = jest.fn();
const mockBuildRemoteArtistRadio = jest.fn();
jest.mock("../../utils/db", () => ({
    prisma: {
        track: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
        artist: { findUnique: jest.fn(), findMany: jest.fn() },
        ownedAlbum: { findMany: jest.fn() },
        similarArtist: { findMany: jest.fn() },
        likedTrack: { findMany: jest.fn() },
        dislikedEntity: { findMany: jest.fn() },
        $queryRaw: jest.fn(),
    },
    Prisma: jest.requireActual("@prisma/client").Prisma,
}));
jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});
jest.mock("../../config", () => ({
    config: {
        underJest: true,
        generationDiversity: { weightAlpha: 0.5, shareCeiling: 0.3 },
    },
}));
jest.mock("../../utils/shuffle", () => ({
    shuffleArray: <T>(rows: T[]) => [...rows],
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));
jest.mock("../libraryRadioCache", () => ({
    loadVibeRadioCandidateIds: mockLoadVibeRadioCandidateIds,
    loadRadioIdCandidatePool: (_key: string, load: () => Promise<string[]>) =>
        load(),
    loadGenreRadioAggregates: jest.fn(),
    loadDecadeRadioAggregates: jest.fn(),
    loadScalarRadioCandidatePool: jest.fn(),
}));
jest.mock("../playlistRemoteRadio", () => ({
    buildRemoteArtistRadio: mockBuildRemoteArtistRadio,
    buildRemoteTrackRadio: jest.fn(),
    buildRemotePlaylistRadio: jest.fn(),
    buildRemoteLikedRadio: jest.fn(),
}));
jest.mock("../libraryRadioStationSelection", () => ({
    isLibraryRadioPlaylistType: () => false,
    selectLibraryRadioStationTracks: jest.fn(),
}));

import { prisma } from "../../utils/db";
import { handleGetRadio } from "../../routes/library/radio";
import {
    selectLibrarySeedRadio as select,
    type LibrarySeedRadioSelection as SeedResult,
} from "../librarySeedRadio";

function createRes() {
    const res = {
        statusCode: 200,
        body: undefined as any,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(body: unknown) {
            this.body = body;
            return this;
        },
    };
    return res;
}

function ids(result: SeedResult): string[] {
    return "trackIds" in result
        ? result.trackIds
        : result.tracks.map((track) => (track as { id: string }).id);
}

const db = prisma as unknown as {
    track: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    artist: { findUnique: jest.Mock; findMany: jest.Mock };
    ownedAlbum: { findMany: jest.Mock };
    similarArtist: { findMany: jest.Mock };
    likedTrack: { findMany: jest.Mock };
    dislikedEntity: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
};

function track(id: string, artistId = "seed-artist") {
    return {
        id,
        title: id,
        duration: 180,
        filePath: id + ".flac",
        bpm: 120,
        energy: 0.4,
        valence: 0.4,
        arousal: 0.4,
        danceability: 0.4,
        instrumentalness: 0.2,
        analysisMode: "standard",
        analysisVersion: null,
        moodHappy: null,
        moodSad: null,
        moodRelaxed: null,
        moodAggressive: null,
        moodParty: null,
        moodAcoustic: null,
        moodElectronic: null,
        keyScale: null,
        lastfmTags: [],
        essentiaGenres: [],
        trackGenres: [] as { genre: { name: string } }[],
        album: {
            id: "album-" + artistId,
            artistId,
            title: "Album",
            genres: [] as string[],
            artist: { id: artistId, name: artistId },
        },
    };
}
let original: ReturnType<typeof track>[];
let related: ReturnType<typeof track>[];
let analyzed: ReturnType<typeof track>[];
let sameArtist: ReturnType<typeof track>[];
let refillPool: ReturnType<typeof track>[];
let source: ReturnType<typeof track> | null;

function matchingRefill(where: any) {
    return refillPool.filter((row) => {
        if (where.id?.notIn?.includes(row.id)) return false;
        const genres = where.trackGenres?.some?.genre?.OR;
        return (
            !genres ||
            row.trackGenres.some(({ genre }) =>
                genres.some(
                    (filter: { name: { equals: string } }) =>
                        genre.name.toLowerCase() ===
                        filter.name.equals.toLowerCase(),
                ),
            )
        );
    });
}

beforeEach(() => {
    jest.resetAllMocks();
    original = [];
    related = [];
    analyzed = [];
    sameArtist = [];
    refillPool = [];
    source = track("source");
    mockLoadVibeRadioCandidateIds.mockImplementation(async () =>
        analyzed.map((row) => row.id),
    );
    db.track.findUnique.mockImplementation(async () => source);
    db.track.count.mockImplementation(
        async ({ where }) => matchingRefill(where).length,
    );
    db.track.findMany.mockImplementation(async (query: any) => {
        if (query.include) {
            const pool = [
                ...original,
                ...related,
                ...analyzed,
                ...sameArtist,
                track("random-fill"),
            ];
            return query.where.id.in.flatMap((id: string) =>
                pool.filter((row) => row.id === id).slice(0, 1),
            );
        }
        if (query.where.id?.in)
            return analyzed.filter((row) => query.where.id.in.includes(row.id));
        if (query.where.album?.artistId?.in) return related;
        if (query.where.album?.artistId === "seed-artist")
            return query.where.id?.notIn ? sameArtist : original;
        return matchingRefill(query.where).slice(
            query.skip ?? 0,
            (query.skip ?? 0) + (query.take ?? 400),
        );
    });
    db.ownedAlbum.findMany.mockResolvedValue(
        [0, 1, 2].map((i) => ({ artistId: "other-" + i })),
    );
    db.similarArtist.findMany.mockResolvedValue(
        [0, 1, 2].map((i) => ({ toArtistId: "other-" + i })),
    );
    db.artist.findUnique.mockResolvedValue({ name: "Seed Artist" });
    db.artist.findMany.mockResolvedValue([]);
    db.likedTrack.findMany.mockResolvedValue([]);
    db.dislikedEntity.findMany.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([]);
    mockBuildRemoteArtistRadio.mockResolvedValue([]);
});

test("artist admission precedes original/similar quotas so a denied prefix does not shorten ten eligible songs", async () => {
    original = Array.from({ length: 8 }, (_, i) => track("original-" + i));
    related = Array.from({ length: 12 }, (_, i) =>
        track("related-" + i, "other-" + (i % 3)),
    );
    const allowed = new Set(
        [...original.slice(4), ...related.slice(3)].map((row) => row.id),
    );
    const result = await select({
        type: "artist",
        value: "seed-artist",
        limit: 10,
        userId: "owner",
        admitTrackIds: async () => allowed,
    });
    expect(ids(result)).toHaveLength(10);
    expect(ids(result).every((id) => allowed.has(id))).toBe(true);
    expect(ids(result).filter((id) => id.startsWith("original-"))).toHaveLength(
        4,
    );
});

test("vibe admission makes fallback eligibility count accepted audio matches rather than denied matches", async () => {
    analyzed = [
        track("ann-denied-1"),
        track("ann-denied-2"),
        track("ann-fresh"),
    ];
    sameArtist = [track("same-denied"), track("same-fresh")];
    const allowed = new Set(["ann-fresh", "same-fresh"]);
    const result = await select({
        type: "vibe",
        value: "source",
        limit: 2,
        admitTrackIds: async () => allowed,
        allowRandomFallback: false,
    });
    expect(ids(result)).toEqual(["ann-fresh", "same-fresh"]);
    expect("sourceFeatures" in result && result.sourceFeatures).toEqual(
        expect.objectContaining({ bpm: 120, analysisMode: "standard" }),
    );
});

test("continuation without relevant candidates stays empty when generic random fallback is disabled", async () => {
    db.$queryRaw.mockResolvedValue([{ id: "random-fill" }]);
    const result = await select({
        type: "vibe",
        value: "source",
        limit: 2,
        allowRandomFallback: false,
    });
    expect(ids(result)).toEqual([]);
});

test("failed admission propagates instead of silently admitting denied source songs", async () => {
    analyzed = [track("ann-denied")];
    await expect(
        select({
            type: "vibe",
            value: "source",
            limit: 1,
            admitTrackIds: async () => {
                throw new Error("policy unavailable");
            },
        }),
    ).rejects.toThrow("policy unavailable");
});

test.each(["genre", "random"])(
    "%s refill admits a bounded candidate pool before the final limit",
    async (refill) => {
        if (refill === "genre") source!.album.genres = ["rock"];
        refillPool = [
            "refill-denied-1",
            "refill-denied-2",
            "refill-fresh-1",
            "refill-fresh-2",
        ].map((id) => ({
            ...track(id),
            trackGenres: [{ genre: { name: "ROCK" } }],
        }));
        const allowed = new Set(["refill-fresh-1", "refill-fresh-2"]);
        const result = await select({
            type: "vibe",
            value: "source",
            limit: 2,
            admitTrackIds: async () => allowed,
            allowRandomFallback: refill === "random",
        });
        expect(ids(result)).toEqual([...allowed]);
        expect(db.track.count).toHaveBeenCalledTimes(1);
        expect(db.$queryRaw).not.toHaveBeenCalled();
        const refillReads = db.track.findMany.mock.calls.filter(
            ([query]) => query.skip !== undefined,
        );
        expect(refillReads).toHaveLength(1);
        expect(refillReads[0][0].take).toBeLessThanOrEqual(400);
    },
);

test("default legacy vibe keeps its ranked match and generic random refill", async () => {
    analyzed = [track("ann-fresh")];
    refillPool = [track("random-fill")];
    db.$queryRaw.mockResolvedValue([{ id: "random-fill" }]);
    const result = await select({ type: "vibe", value: "source", limit: 2 });
    expect(ids(result)).toEqual(["ann-fresh", "random-fill"]);
});

test("legacy random window wraps a short tail in one bounded extra read", async () => {
    refillPool = [0, 1, 2, 3].map((i) => track("random-" + i));
    const random = jest.spyOn(Math, "random").mockReturnValue(0.75);
    try {
        const result = await select({
            type: "vibe",
            value: "source",
            limit: 2,
        });
        expect(ids(result)).toEqual(["random-3", "random-0"]);
        const reads = db.track.findMany.mock.calls.filter(
            ([query]) => query.skip !== undefined,
        );
        expect(reads.map(([query]) => [query.skip, query.take])).toEqual([
            [3, 2],
            [0, 1],
        ]);
        expect(db.track.count).toHaveBeenCalledTimes(1);
    } finally {
        random.mockRestore();
    }
});

test("genre fallback excludes unrelated random songs when continuation disables random refill", async () => {
    source!.album.genres = ["rock"];
    refillPool = [
        {
            ...track("related-genre"),
            trackGenres: [{ genre: { name: "Rock" } }],
        },
        {
            ...track("unrelated-genre"),
            trackGenres: [{ genre: { name: "Jazz" } }],
        },
    ];
    const result = await select({
        type: "vibe",
        value: "source",
        limit: 2,
        allowRandomFallback: false,
    });
    expect(ids(result)).toEqual(["related-genre"]);
    expect(db.track.count).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw).not.toHaveBeenCalled();
});

test("count/read race returns a short random pool after at most two reads", async () => {
    refillPool = [0, 1, 2, 3].map((i) => track("vanished-" + i));
    const read = db.track.findMany.getMockImplementation()!;
    db.track.findMany.mockImplementation(async (query) =>
        query.skip !== undefined ? [] : read(query),
    );
    const random = jest.spyOn(Math, "random").mockReturnValue(0.75);
    try {
        const result = await select({
            type: "vibe",
            value: "source",
            limit: 2,
        });
        expect(ids(result)).toEqual([]);
        expect(db.track.count).toHaveBeenCalledTimes(1);
        expect(
            db.track.findMany.mock.calls.filter(
                ([query]) => query.skip !== undefined,
            ),
        ).toHaveLength(2);
    } finally {
        random.mockRestore();
    }
});

test("default legacy artist keeps four originals and six diversified similar songs", async () => {
    original = Array.from({ length: 8 }, (_, i) => track("original-" + i));
    related = Array.from({ length: 12 }, (_, i) =>
        track("related-" + i, "other-" + (i % 3)),
    );
    const res = createRes();
    await handleGetRadio(
        {
            query: { type: "artist", value: "seed-artist", limit: "10" },
            user: { id: "owner" },
        } as unknown as Request,
        res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.tracks).toHaveLength(10);
    expect(
        res.body.tracks.filter((row: { id: string }) =>
            row.id.startsWith("original-"),
        ),
    ).toHaveLength(4);
    expect(
        res.body.tracks.filter((row: { id: string }) =>
            row.id.startsWith("related-"),
        ),
    ).toHaveLength(6);
});

test("catalog-only artist forwards partial provider failure without dropping successful tracks", async () => {
    const tracks = [{ id: "radio:abcdefghijk" }];
    const onPartialFailure = jest.fn();
    const admitTrackIds = jest.fn();
    mockBuildRemoteArtistRadio.mockImplementation(
        async (_name, _limit, reportPartialFailure) => {
            reportPartialFailure?.();
            return tracks;
        },
    );
    const result = await select({
        type: "artist",
        value: "seed-artist",
        limit: 10,
        admitTrackIds,
        onRemotePartialFailure: onPartialFailure,
    });
    expect(onPartialFailure).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ tracks });
    expect(admitTrackIds).not.toHaveBeenCalled();
});

test("catalog-only legacy artist retains the two-argument remote call", async () => {
    const tracks = [{ id: "radio:abcdefghijk" }];
    mockBuildRemoteArtistRadio.mockResolvedValue(tracks);
    const res = createRes();
    await handleGetRadio(
        {
            query: { type: "artist", value: "seed-artist", limit: "10" },
        } as unknown as Request,
        res as unknown as Response,
    );
    expect(mockBuildRemoteArtistRadio).toHaveBeenCalledWith("Seed Artist", 10);
    expect(res.body).toEqual({ tracks });
});

test.each([
    ["artist", undefined, 400, "Artist ID required for artist radio"],
    ["vibe", undefined, 400, "Track ID required for vibe matching"],
    ["vibe", "missing-source", 404, "Track not found"],
])(
    "legacy %s source error keeps HTTP envelope",
    async (type, value, status, message) => {
        source = null;
        const res = createRes();
        await handleGetRadio(
            {
                query: { type, value, limit: "10" },
                user: { id: "owner" },
            } as unknown as Request,
            res as unknown as Response,
        );
        expect(res.statusCode).toBe(status);
        expect(res.body).toEqual({ error: message });
    },
);
