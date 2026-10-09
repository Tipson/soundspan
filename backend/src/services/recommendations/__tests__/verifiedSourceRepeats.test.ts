const mockRepeatPlays = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: { play: { findMany: mockRepeatPlays } },
}));

import { loadVerifiedSourceRepeatExclusions } from "../verifiedSourceRepeats";

const NOW = new Date("2026-10-08T12:00:00Z");
const DAY = 86_400_000;
function namespace(
    provider: "vk" | "yandex",
    id = provider === "vk" ? "-001_002" : "0007",
) {
    return {
        provider,
        providerTrackId: id,
        verifiedMetadata: {
            provider,
            id,
            title: "Same title",
            artists: ["Same artist"],
            duration: 180,
            contentVersion: "unknown",
            preview: false,
        },
        metadataObservedAt: NOW as Date | null,
        metadataConnectionVersion: 2 as number | null,
        mappings: [
            {
                stale: false,
                canonicalRecording: {
                    id: provider,
                    canonicalKey: `exact:${provider}`,
                    mergedIntoId: null as string | null,
                    identitySource: "verified-source",
                },
            },
        ],
    };
}
function play(provider: "vk" | "yandex", index = 0) {
    return {
        id: `row-${String(index).padStart(4, "0")}`,
        userId: "alice",
        source: provider === "vk" ? "VK" : "YANDEX",
        trackMusicSource: namespace(provider),
        playedAt: new Date(NOW.getTime() - index * 1_000),
        listenedSeconds: 0 as number | null,
        outcome: null as string | null,
    };
}
let corpus: Array<ReturnType<typeof play>>;
function useCorpus() {
    mockRepeatPlays.mockImplementation(async (query) => {
        if (query.select.musicSourceRecording)
            throw new Error("Private activity is not attestation");
        const where = query.where;
        const pair = where.AND.find((part: any) =>
            part.OR?.some((branch: any) => branch.trackMusicSource),
        )?.OR;
        const rows = corpus
            .filter((row) => {
                if (
                    row.userId !== where.userId ||
                    row.playedAt < where.playedAt.gte ||
                    row.playedAt > where.playedAt.lte
                )
                    return false;
                if (row.outcome === "failed") return false;
                if (
                    row.playedAt.getTime() <= NOW.getTime() - DAY &&
                    (row.listenedSeconds ?? 0) < 30
                )
                    return false;
                return pair?.some((branch: any) => {
                    const ns = row.trackMusicSource;
                    return (
                        row.source === branch.source &&
                        ns?.provider === branch.trackMusicSource.is.provider &&
                        ns.verifiedMetadata &&
                        ns.metadataObservedAt &&
                        (ns.metadataConnectionVersion ?? 0) > 0
                    );
                });
            })
            .sort(
                (a, b) =>
                    b.playedAt.getTime() - a.playedAt.getTime() ||
                    a.id.localeCompare(b.id),
            );
        const offset = query.cursor
            ? rows.findIndex((row) => row.id === query.cursor.id) + query.skip
            : 0;
        return rows.slice(offset, offset + query.take).map((row) => ({
            ...row,
            trackMusicSource: {
                ...row.trackMusicSource,
                mappings: row.trackMusicSource.mappings
                    .filter(
                        (mapping) =>
                            !mapping.stale &&
                            !mapping.canonicalRecording.mergedIntoId &&
                            mapping.canonicalRecording.identitySource !==
                                "identity-merged",
                    )
                    .slice(0, 1),
            },
        }));
    });
}

describe("exact verified source repeats without analysis/session/provider access", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        corpus = [];
        useCorpus();
    });

    it.each(["vk", "yandex"] as const)(
        "uses leading-zero %s actual attempts without embeddings or session",
        async (provider) => {
            corpus = [play(provider)];
            const result = await loadVerifiedSourceRepeatExclusions(
                "alice",
                NOW,
            );
            expect([...result.ids]).toEqual([
                `${provider}:${corpus[0].trackMusicSource.providerTrackId}`,
                `exact:${provider}`,
            ]);
            expect(result.hardIds).toEqual(result.ids);
        },
    );

    it("keeps >=30-second last-week listening soft and shorter listening neutral", async () => {
        const heard = play("vk");
        heard.playedAt = new Date(NOW.getTime() - 2 * DAY);
        heard.listenedSeconds = 30;
        const brief = play("yandex", 1);
        brief.playedAt = heard.playedAt;
        brief.listenedSeconds = 29;
        corpus = [heard, brief];
        const result = await loadVerifiedSourceRepeatExclusions("alice", NOW);
        expect([...result.ids]).toEqual(["vk:-001_002", "exact:vk"]);
        expect([...result.hardIds]).toEqual([]);
    });

    it.each([0, 30])(
        "preserves strict 24h/7d boundaries with %s listened seconds",
        async (seconds) => {
            const lastDay = play("vk");
            lastDay.playedAt = new Date(NOW.getTime() - DAY);
            lastDay.listenedSeconds = seconds;
            const lastWeek = play("yandex", 1);
            lastWeek.playedAt = new Date(NOW.getTime() - 7 * DAY);
            lastWeek.listenedSeconds = 180;
            corpus = [lastDay, lastWeek];
            const result = await loadVerifiedSourceRepeatExclusions(
                "alice",
                NOW,
            );
            expect([...result.ids]).toEqual(
                seconds === 30 ? ["vk:-001_002", "exact:vk"] : [],
            );
            expect([...result.hardIds]).toEqual([]);
        },
    );

    it("keeps failed attempts and future activity neutral", async () => {
        const failed = play("vk");
        failed.outcome = "failed";
        failed.listenedSeconds = 180;
        const future = play("yandex", 1);
        future.playedAt = new Date(NOW.getTime() + 1);
        corpus = [failed, future];
        expect([
            ...(await loadVerifiedSourceRepeatExclusions("alice", NOW)).ids,
        ]).toEqual([]);
    });

    it.each(["unmapped", "stale", "merged"])(
        "still suppresses the exact namespace with a %s canonical mapping",
        async (kind) => {
            const row = play("vk");
            if (kind === "unmapped") row.trackMusicSource.mappings = [];
            else if (kind === "stale")
                row.trackMusicSource.mappings[0].stale = true;
            else
                row.trackMusicSource.mappings[0].canonicalRecording.mergedIntoId =
                    "survivor";
            corpus = [row];
            expect([
                ...(await loadVerifiedSourceRepeatExclusions("alice", NOW)).ids,
            ]).toEqual(["vk:-001_002"]);
        },
    );

    it.each([
        "id",
        "provider",
        "preview",
        "artist",
        "version",
        "date",
        "source",
    ])(
        "rejects %s conflicts instead of inventing title/artist equivalence",
        async (kind) => {
            const bad = play("vk");
            if (kind === "id") bad.trackMusicSource.verifiedMetadata.id = "1_2";
            else if (kind === "provider")
                bad.trackMusicSource.verifiedMetadata.provider = "yandex";
            else if (kind === "preview")
                bad.trackMusicSource.verifiedMetadata.preview = true;
            else if (kind === "artist")
                bad.trackMusicSource.verifiedMetadata.artists = [];
            else if (kind === "version")
                bad.trackMusicSource.metadataConnectionVersion = null;
            else if (kind === "date")
                bad.trackMusicSource.metadataObservedAt = null;
            else bad.source = "YANDEX";
            corpus = [bad];
            expect([
                ...(await loadVerifiedSourceRepeatExclusions("alice", NOW)).ids,
            ]).toEqual([]);
        },
    );

    it("isolates the owner before a full foreign history quota", async () => {
        corpus = [
            ...Array.from({ length: 1_000 }, (_, i) => ({
                ...play("vk", i),
                userId: "bob",
            })),
            play("yandex", 1_001),
        ];
        expect([
            ...(await loadVerifiedSourceRepeatExclusions("alice", NOW)).ids,
        ]).toEqual(["yandex:0007", "exact:yandex"]);
        expect(mockRepeatPlays).toHaveBeenCalledTimes(1);
    });

    it("passes a full weak page using the raw cursor and preserves an older valid row", async () => {
        corpus = Array.from({ length: 100 }, (_, i) => {
            const row = play("vk", i);
            row.trackMusicSource.verifiedMetadata.artists = [];
            return row;
        });
        corpus.push(play("yandex", 100));
        expect([
            ...(await loadVerifiedSourceRepeatExclusions("alice", NOW)).ids,
        ]).toEqual(["yandex:0007", "exact:yandex"]);
        expect(mockRepeatPlays).toHaveBeenCalledTimes(2);
        expect(mockRepeatPlays.mock.calls[1][0].cursor).toEqual({
            id: "row-0099",
        });
    });

    it("caps a pathological weak scan at the separate 1,000-row ceiling", async () => {
        corpus = Array.from({ length: 1_000 }, (_, i) => {
            const row = play("vk", i);
            row.trackMusicSource.verifiedMetadata.artists = [];
            return row;
        });
        corpus.push(play("yandex", 1_000));
        expect([
            ...(await loadVerifiedSourceRepeatExclusions("alice", NOW)).ids,
        ]).toEqual([]);
        expect(mockRepeatPlays).toHaveBeenCalledTimes(10);
    });

    it("does not collapse unconfirmed cross-source song versions by equal titles or artists", async () => {
        corpus = [play("vk"), play("yandex", 1)];
        const result = await loadVerifiedSourceRepeatExclusions("alice", NOW);
        expect([...result.ids]).toEqual([
            "vk:-001_002",
            "exact:vk",
            "yandex:0007",
            "exact:yandex",
        ]);
    });

    it("deduplicates only a known live canonical identity", async () => {
        const first = play("vk");
        const second = play("yandex", 1);
        second.trackMusicSource.mappings[0].canonicalRecording.canonicalKey =
            "exact:vk";
        corpus = [first, second];
        expect([
            ...(await loadVerifiedSourceRepeatExclusions("alice", NOW)).ids,
        ]).toEqual(["vk:-001_002", "exact:vk", "yandex:0007"]);
    });

    it("preserves a live canonical key verbatim even if it has a legacy prefix", async () => {
        const row = play("vk");
        row.trackMusicSource.mappings[0].canonicalRecording.canonicalKey =
            "yt:canonicalVideo";
        corpus = [row];
        const result = await loadVerifiedSourceRepeatExclusions("alice", NOW);
        expect(result.ids).toEqual(
            new Set(["vk:-001_002", "yt:canonicalVideo"]),
        );
        expect(result.hardIds).toEqual(result.ids);
    });

    it("rejects a partial history if a later page is unavailable", async () => {
        corpus = Array.from({ length: 100 }, (_, i) => play("vk", i));
        const faithful = mockRepeatPlays.getMockImplementation()!;
        mockRepeatPlays.mockImplementation(async (query) =>
            query.cursor
                ? Promise.reject(new Error("query unavailable"))
                : faithful(query),
        );
        await expect(
            loadVerifiedSourceRepeatExclusions("alice", NOW),
        ).rejects.toThrow("query unavailable");
    });

    it("does not issue another page after a request-owned phase fence stops a held query", async () => {
        corpus = Array.from({ length: 100 }, (_, i) => play("vk", i));
        const faithful = mockRepeatPlays.getMockImplementation()!;
        let stopped = false;
        mockRepeatPlays.mockImplementation(async (query) => {
            const rows = await faithful(query);
            stopped = true;
            return rows;
        });
        const check = () => {
            if (stopped) throw new Error("request stopped");
        };
        await expect(
            loadVerifiedSourceRepeatExclusions("alice", NOW, check),
        ).rejects.toThrow("request stopped");
        expect(mockRepeatPlays).toHaveBeenCalledTimes(1);
    });
});
