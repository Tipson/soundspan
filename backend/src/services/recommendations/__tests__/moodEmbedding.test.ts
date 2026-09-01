jest.mock("../../../config", () => ({
    config: { features: { audioAnalysis: false }, vibeProviderUrl: "" },
}));
jest.mock("../../embeddingSpaces", () => ({ getActiveSpace: jest.fn() }));
jest.mock("../../vibeProvider", () => ({
    assertProviderMatchesActiveSpace: jest.fn(),
    embedText: jest.fn(),
    fetchProviderSpace: jest.fn(),
}));

import { RecommendationMoodEmbeddingStore } from "../moodEmbedding";

describe("recommendation mood embedding store", () => {
    function dependencies() {
        return {
            enabled: true,
            loadSpace: jest.fn().mockResolvedValue({ id: "space-1", dim: 2 }),
            embedText: jest.fn().mockResolvedValue([1, 0]),
            now: jest.fn(() => new Date("2026-09-01T12:00:00.000Z")),
            timeoutMs: 50,
        };
    }

    it("reuses one validated DCLAP mood vector per embedding space", async () => {
        const deps = dependencies();
        const store = new RecommendationMoodEmbeddingStore(deps);

        await expect(store.load("focus")).resolves.toEqual({
            embedding: [1, 0],
            degraded: false,
        });
        await expect(store.load("focus")).resolves.toEqual({
            embedding: [1, 0],
            degraded: false,
        });

        expect(deps.embedText).toHaveBeenCalledTimes(1);
        expect(deps.embedText).toHaveBeenCalledWith(
            expect.stringContaining("focus"),
            { id: "space-1", dim: 2 },
        );
    });

    it("bounds a missing provider and negative-caches the degraded result", async () => {
        jest.useFakeTimers();
        const deps = dependencies();
        deps.embedText.mockImplementation(() => new Promise(() => undefined));
        const store = new RecommendationMoodEmbeddingStore(deps);

        const pending = store.load("calm");
        await jest.advanceTimersByTimeAsync(50);

        await expect(pending).resolves.toEqual({
            embedding: null,
            degraded: true,
        });
        await expect(store.load("calm")).resolves.toEqual({
            embedding: null,
            degraded: true,
        });
        expect(deps.embedText).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    it("does not call DCLAP for preference-only moments", async () => {
        const deps = dependencies();
        const store = new RecommendationMoodEmbeddingStore(deps);

        await expect(store.load("forgotten")).resolves.toEqual({
            embedding: null,
            degraded: false,
        });
        expect(deps.loadSpace).not.toHaveBeenCalled();
    });
});
