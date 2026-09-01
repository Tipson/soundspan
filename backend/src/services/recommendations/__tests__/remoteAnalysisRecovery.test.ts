const recoverExpiredRemoteAnalysisAssets = jest.fn(async () => 2);
const mockedConfig = { recommendations: { remoteAnalysisEnabled: true } };

jest.mock("../../../config", () => ({
    config: mockedConfig,
}));
jest.mock("../remoteAnalysisHotSet", () => ({
    recoverExpiredRemoteAnalysisAssets,
}));
jest.mock("../../../utils/logger", () => ({
    logger: {
        child: () => ({ info: jest.fn(), warn: jest.fn() }),
    },
}));

import {
    startRemoteAnalysisAssetRecovery,
    stopRemoteAnalysisAssetRecovery,
} from "../remoteAnalysisRecovery";

describe("remote analysis asset recovery loop", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        recoverExpiredRemoteAnalysisAssets.mockClear();
        mockedConfig.recommendations.remoteAnalysisEnabled = true;
    });

    afterEach(async () => {
        await stopRemoteAnalysisAssetRecovery();
        jest.useRealTimers();
    });

    it("runs at startup and periodically without duplicate intervals", async () => {
        startRemoteAnalysisAssetRecovery();
        startRemoteAnalysisAssetRecovery();
        await jest.advanceTimersByTimeAsync(0);

        expect(recoverExpiredRemoteAnalysisAssets).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(15 * 60 * 1_000);
        expect(recoverExpiredRemoteAnalysisAssets).toHaveBeenCalledTimes(2);

        await stopRemoteAnalysisAssetRecovery();
        await jest.advanceTimersByTimeAsync(15 * 60 * 1_000);
        expect(recoverExpiredRemoteAnalysisAssets).toHaveBeenCalledTimes(2);
    });

    it("keeps recovering existing assets after new admission is disabled", async () => {
        mockedConfig.recommendations.remoteAnalysisEnabled = false;

        startRemoteAnalysisAssetRecovery();
        await jest.advanceTimersByTimeAsync(0);

        expect(recoverExpiredRemoteAnalysisAssets).toHaveBeenCalledTimes(1);
    });
});
