jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            warn: jest.fn(),
            error: jest.fn(),
        }),
    },
}));

const recommendSimilar = jest.fn();

jest.mock("../../services/recommendations/recommendationRuntime", () => ({
    unifiedRecommendationService: {
        recommendSimilar: (...args: unknown[]) => recommendSimilar(...args),
    },
}));

import router from "../playerRelated";
import { createMockJsonResponse } from "./helpers/mockJsonResponse";

function getHandler() {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === "/" && entry.route.methods.get,
    );
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("player related route", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns playable tracks, artists and albums for an online-only seed", async () => {
        recommendSimilar.mockResolvedValue({
            tracks: [
                {
                    id: "yt:related-video",
                    canonicalKey: "meta:related artist:related:205",
                    title: "Related",
                    duration: 205,
                    artist: { id: "UCrelated", name: "Related Artist" },
                    album: {
                        id: "MPRErelated",
                        title: "Related Album",
                        coverArt: "https://img/related",
                    },
                    source: "youtube",
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: "related-video",
                    },
                    streamSource: "youtube",
                    youtubeVideoId: "related-video",
                    candidateSources: ["youtube-radio"],
                    providerPrior: 1,
                },
            ],
            nextCursor: 1,
            generationId: "generation-1",
            degradedSources: [],
        });

        const req = {
            user: { id: "user-1" },
            query: {
                seedTrackId: "yt:seed-video",
                artist: "Seed Artist",
                title: "Seed",
                limit: "12",
            },
        } as any;
        const res = createMockJsonResponse();

        await getHandler()(req, res);

        expect(res.statusCode).toBe(200);
        expect(recommendSimilar).toHaveBeenCalledWith({
            userId: "user-1",
            sessionId: expect.any(String),
            intent: {
                surface: "similar-tracks",
                direction: "for-you",
                mood: null,
            },
            cursor: 0,
            limit: 12,
            exclude: ["yt:seed-video", "seed-video"],
            seed: {
                id: "yt:seed-video",
                artist: "Seed Artist",
                title: "Seed",
            },
        });
        expect(res.body.tracks).toEqual([
            expect.objectContaining({
                id: "yt:related-video",
                artist: "Related Artist",
                youtubeVideoId: "related-video",
                streamSource: "youtube",
            }),
        ]);
        expect(res.body.artists).toEqual([
            expect.objectContaining({
                name: "Related Artist",
                providerId: "UCrelated",
            }),
        ]);
        expect(res.body.albums).toEqual([
            expect.objectContaining({
                id: "MPRErelated",
                title: "Related Album",
                provider: "youtube",
            }),
        ]);
        expect(res.body.degradedSources).toEqual([]);
        expect(res.body.generationId).toBe("generation-1");
    });

    it("resolves a non-provider seed by metadata before loading radio", async () => {
        recommendSimilar.mockResolvedValue({
            tracks: [],
            nextCursor: 1,
            generationId: "generation-2",
            degradedSources: ["youtube-seed"],
        });
        const req = {
            user: { id: "user-1" },
            query: {
                seedTrackId: "local-track",
                artist: "Artist",
                title: "Title",
            },
        } as any;
        const res = createMockJsonResponse();

        await getHandler()(req, res);

        expect(recommendSimilar).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "user-1",
                seed: {
                    id: "local-track",
                    artist: "Artist",
                    title: "Title",
                },
            }),
        );
        expect(res.statusCode).toBe(200);
    });

    it("forwards bounded cursor and the browser session", async () => {
        recommendSimilar.mockResolvedValue({
            tracks: [],
            nextCursor: 8,
            generationId: "generation-3",
            degradedSources: [],
        });
        const req = {
            user: { id: "user-1" },
            query: {
                seedTrackId: "yt:seed-video",
                sessionId: "tab-1",
                cursor: "7",
                limit: "999",
            },
        } as any;
        const res = createMockJsonResponse();

        await getHandler()(req, res);

        expect(recommendSimilar).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "tab-1",
                cursor: 7,
                limit: 25,
            }),
        );
    });
});
