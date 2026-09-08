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
    afterEach(() => jest.useRealTimers());
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

    it("bounds callers, coalesces slow work and negative-caches a failed fill", async () => {
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
        const second = store.load("calm");
        await jest.advanceTimersByTimeAsync(50);
        await expect(second).resolves.toEqual({
            embedding: null,
            degraded: true,
        });
        expect(deps.embedText).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(15_000);
        await expect(store.load("calm")).resolves.toEqual({
            embedding: null,
            degraded: true,
        });
        expect(deps.embedText).toHaveBeenCalledTimes(1);
    });

    it("keeps a valid late vector for the next request instead of disabling mood for five minutes", async () => {
        jest.useFakeTimers();
        const deps = dependencies();
        let finish!: (value: number[]) => void;
        deps.embedText.mockImplementation(
            () =>
                new Promise<number[]>((resolve) => {
                    finish = resolve;
                }),
        );
        const store = new RecommendationMoodEmbeddingStore(deps);
        const callers = Array.from({ length: 10 }, () => store.load("focus"));
        await jest.advanceTimersByTimeAsync(50);
        expect(await Promise.all(callers)).toEqual(
            Array.from({ length: 10 }, () => ({
                embedding: null,
                degraded: true,
            })),
        );
        expect(deps.embedText).toHaveBeenCalledTimes(1);
        finish([1, 0]);
        await jest.advanceTimersByTimeAsync(1);
        await expect(store.load("focus")).resolves.toEqual({
            embedding: [1, 0],
            degraded: false,
        });
        expect(deps.embedText).toHaveBeenCalledTimes(1);
    });

    it("observes late provider rejection without starting duplicate work", async () => {
        jest.useFakeTimers();
        const deps = dependencies();
        let fail!: (error: Error) => void;
        deps.embedText.mockImplementation(
            () =>
                new Promise<number[]>((_resolve, reject) => {
                    fail = reject;
                }),
        );
        const store = new RecommendationMoodEmbeddingStore(deps);
        const pending = store.load("focus");
        await jest.advanceTimersByTimeAsync(50);
        await expect(pending).resolves.toEqual({
            embedding: null,
            degraded: true,
        });
        fail(new Error("provider unavailable"));
        await jest.advanceTimersByTimeAsync(1);
        await expect(store.load("focus")).resolves.toEqual({
            embedding: null,
            degraded: true,
        });
        expect(deps.embedText).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid vectors even when they arrive after the caller deadline", async () => {
        jest.useFakeTimers();
        const deps = dependencies();
        let finish!: (value: number[]) => void;
        deps.embedText.mockImplementation(
            () =>
                new Promise<number[]>((resolve) => {
                    finish = resolve;
                }),
        );
        const store = new RecommendationMoodEmbeddingStore(deps);
        const pending = store.load("energetic");
        await jest.advanceTimersByTimeAsync(50);
        await pending;
        finish([Number.NaN, 0]);
        await jest.advanceTimersByTimeAsync(1);
        await expect(store.load("energetic")).resolves.toEqual({
            embedding: null,
            degraded: true,
        });
        expect(deps.embedText).toHaveBeenCalledTimes(1);
    });

    it("does not install a vector after the fill's hard deadline", async () => {
        jest.useFakeTimers();
        const deps = dependencies();
        let finish!: (value: number[]) => void;
        deps.embedText.mockImplementation(
            () =>
                new Promise<number[]>((resolve) => {
                    finish = resolve;
                }),
        );
        const store = new RecommendationMoodEmbeddingStore(deps);
        const pending = store.load("workout");
        await jest.advanceTimersByTimeAsync(15_001);
        await pending;
        finish([1, 0]);
        await jest.advanceTimersByTimeAsync(1);
        await expect(store.load("workout")).resolves.toEqual({
            embedding: null,
            degraded: true,
        });
        expect(deps.embedText).toHaveBeenCalledTimes(1);
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
