const mockSessionPlayFindMany = jest.fn();
const mockSessionMappingFindMany = jest.fn();
const mockSessionQueryRaw = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        play: { findMany: mockSessionPlayFindMany },
        trackMapping: { findMany: mockSessionMappingFindMany },
        canonicalRecording: { findMany: jest.fn().mockResolvedValue([]) },
        $queryRaw: mockSessionQueryRaw,
    },
}));

import { recommendationFeatureStore } from "../featureStore";

interface SessionPlay {
    userId: string;
    recommendationSessionId: string;
    source: string;
    trackId: string | null;
    trackTidalId: string | null;
    trackYtMusicId: string | null;
    playedAt: Date;
    outcome: string;
    completionRatio: number;
    listenedSeconds: number;
}

type MappingField = "trackId" | "trackTidalId" | "trackYtMusicId";
interface SessionMapping {
    trackId: string | null;
    trackTidalId: string | null;
    trackYtMusicId: string | null;
    canonicalRecordingId: string;
}

const NOW = new Date("2026-10-08T04:00:00.000Z");

function play(overrides: Partial<SessionPlay> = {}): SessionPlay {
    return {
        userId: "alice",
        recommendationSessionId: "session-a",
        source: "YOUTUBE_MUSIC",
        trackId: null,
        trackTidalId: null,
        trackYtMusicId: "youtube-row",
        playedAt: new Date(NOW.getTime() - 60_000),
        outcome: "completed",
        completionRatio: 1,
        listenedSeconds: 180,
        ...overrides,
    };
}

function useCorpus(plays: SessionPlay[], mappings: SessionMapping[]) {
    mockSessionPlayFindMany.mockImplementation(
        async (query: {
            where: {
                userId: string;
                recommendationSessionId: string;
                source?: { notIn: string[] };
            };
            take: number;
        }) =>
            plays
                .filter(
                    (row) =>
                        row.userId === query.where.userId &&
                        row.recommendationSessionId ===
                            query.where.recommendationSessionId &&
                        !!query.where.source?.notIn &&
                        !query.where.source.notIn.includes(row.source),
                )
                .sort(
                    (left, right) =>
                        right.playedAt.getTime() - left.playedAt.getTime(),
                )
                .slice(0, query.take),
    );
    mockSessionMappingFindMany.mockImplementation(
        async (query: {
            where: { OR?: Partial<Record<MappingField, { in: string[] }>>[] };
        }) =>
            mappings.filter((row) =>
                (query.where.OR ?? []).some((identity) =>
                    (Object.keys(identity) as MappingField[]).some(
                        (field) =>
                            row[field] !== null &&
                            identity[field]?.in.includes(row[field]!),
                    ),
                ),
            ),
    );
    mockSessionQueryRaw.mockImplementation(
        async (_query: TemplateStringsArray, ids: unknown) =>
            Array.isArray(ids)
                ? ids.map((canonicalRecordingId) => ({
                      canonicalRecordingId,
                      embedding: "[1,0]",
                      bpm: 120,
                      energy: 0.5,
                      arousal: 0.2,
                      valence: 0.4,
                      danceability: 0.3,
                      instrumentalness: 0.1,
                  }))
                : [],
    );
}

const youtubeMapping: SessionMapping = {
    trackId: null,
    trackTidalId: null,
    trackYtMusicId: "youtube-row",
    canonicalRecordingId: "canonical-youtube",
};

describe("canonical session play quota", () => {
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW);
        mockSessionPlayFindMany.mockReset();
        mockSessionMappingFindMany.mockReset();
        mockSessionQueryRaw.mockReset();
    });

    afterEach(() => jest.useRealTimers());

    it("keeps a canonical signal behind 30 newer direct-source plays", async () => {
        useCorpus(
            [
                ...Array.from({ length: 30 }, (_, index) =>
                    play({
                        source: index % 2 === 0 ? "VK" : "YANDEX",
                        trackYtMusicId: null,
                        playedAt: new Date(NOW.getTime() - index),
                    }),
                ),
                play(),
            ],
            [youtubeMapping],
        );

        const result = await recommendationFeatureStore.loadTasteContext(
            "alice",
            { sessionId: "session-a" },
        );

        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionPositiveEmbedding).toEqual([1, 0]);
    });

    it("keeps the account and session boundaries before the play quota", async () => {
        useCorpus(
            [
                ...Array.from({ length: 30 }, () => play({ userId: "bob" })),
                ...Array.from({ length: 30 }, () =>
                    play({ recommendationSessionId: "another-session" }),
                ),
                play(),
            ],
            [youtubeMapping],
        );

        const result = await recommendationFeatureStore.loadTasteContext(
            "alice",
            { sessionId: "session-a" },
        );

        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionPositiveEmbedding).toEqual([1, 0]);
    });

    it.each<[string, MappingField]>([
        ["LIBRARY", "trackId"],
        ["DISCOVERY_KEPT", "trackId"],
        ["TIDAL", "trackTidalId"],
        ["YOUTUBE_MUSIC", "trackYtMusicId"],
    ])("preserves the %s canonical mapping", async (source, field) => {
        const identity = {
            trackId: null,
            trackTidalId: null,
            trackYtMusicId: null,
            [field]: "legacy-row",
        };
        useCorpus(
            [play({ ...identity, source })],
            [{ ...identity, canonicalRecordingId: "canonical-legacy" }],
        );

        const result = await recommendationFeatureStore.loadTasteContext(
            "alice",
            { sessionId: "session-a" },
        );

        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionPositiveEmbedding).toEqual([1, 0]);
    });

    it("retains the 30-play bound for recognized session signals", async () => {
        useCorpus(
            Array.from({ length: 31 }, () => play()),
            [youtubeMapping],
        );

        const result = await recommendationFeatureStore.loadTasteContext(
            "alice",
            { sessionId: "session-a" },
        );

        expect(result.sessionSignalCount).toBe(30);
    });
});
