const mockProcessBatch = jest.fn();

jest.mock("../canonicalIdentityPromotion", () => ({
    processCanonicalIdentityPromotionBatch: (...args: unknown[]) =>
        mockProcessBatch(...args),
}));
jest.mock("../../../utils/logger", () => {
    const channel = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };
    return { logger: { ...channel, child: jest.fn(() => channel) } };
});

import {
    startCanonicalIdentityPromotionSweep,
    stopCanonicalIdentityPromotionSweep,
} from "../canonicalIdentityPromotionSweep";

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe("canonical identity promotion sweep", () => {
    beforeEach(async () => {
        await stopCanonicalIdentityPromotionSweep();
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockProcessBatch.mockResolvedValue({
            completed: 0,
            deferred: 0,
            failed: 0,
            stale: 0,
        });
    });

    afterEach(async () => {
        await stopCanonicalIdentityPromotionSweep();
        jest.useRealTimers();
    });

    it("starts immediately, stays singleton and repeats on a bounded cadence", async () => {
        startCanonicalIdentityPromotionSweep();
        startCanonicalIdentityPromotionSweep();
        await flushPromises();

        expect(mockProcessBatch).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(5_000);
        expect(mockProcessBatch).toHaveBeenCalledTimes(2);
    });

    it("does not overlap an unfinished settlement pass", async () => {
        let finish: (() => void) | undefined;
        mockProcessBatch.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = () =>
                    resolve({
                        completed: 0,
                        deferred: 0,
                        failed: 0,
                        stale: 0,
                    });
            }),
        );
        startCanonicalIdentityPromotionSweep();

        await jest.advanceTimersByTimeAsync(15_000);
        expect(mockProcessBatch).toHaveBeenCalledTimes(1);
        finish?.();
        await flushPromises();
        await jest.advanceTimersByTimeAsync(5_000);
        expect(mockProcessBatch).toHaveBeenCalledTimes(2);
    });
});
