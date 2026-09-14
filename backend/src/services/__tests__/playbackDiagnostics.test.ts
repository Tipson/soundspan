const mockWarn = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: mockWarn }) },
}));
import { createPlaybackDiagnosticRecorder } from "../playbackDiagnostics";

describe("playback diagnostic records", () => {
    beforeEach(() => jest.clearAllMocks());
    it("records bounded useful fields at warn level without raw client input", () => {
        const record = createPlaybackDiagnosticRecorder();
        record(
            "user-a",
            "player.unexpected_stop",
            {
                trackId: "yt:track-1",
                currentTimeSec: 83,
                bufferedAheadSec: 0,
                online: false,
                token: "SECRET",
                error: "https://secret",
                userId: "user-b",
                reason: "heartbeat_unexpected_stop",
            },
            { id: "event-1", ownerId: "user-a", observedAtMs: 100_000 },
        );
        expect(mockWarn).toHaveBeenCalledTimes(1);
        const data = JSON.parse(mockWarn.mock.calls[0][0]);
        expect(data).toEqual(
            expect.objectContaining({
                userId: "user-a",
                event: "player.unexpected_stop",
                eventId: "event-1",
                observedAtMs: 100_000,
                fields: {
                    trackId: "yt:track-1",
                    currentTimeSec: 83,
                    bufferedAheadSec: 0,
                    online: false,
                    reason: "heartbeat_unexpected_stop",
                },
            }),
        );
        expect(mockWarn.mock.calls[0][0]).not.toContain("SECRET");
    });
    it("rejects another account's queued events and deduplicates retries", () => {
        const record = createPlaybackDiagnosticRecorder();
        const delivery = {
            id: "event-1",
            ownerId: "user-a",
            observedAtMs: 100_000,
        };
        record("user-b", "player.unexpected_stop", {}, delivery);
        expect(mockWarn).not.toHaveBeenCalled();
        record("user-a", "player.unexpected_stop", {}, delivery);
        record("user-a", "player.unexpected_stop", {}, delivery);
        expect(mockWarn).toHaveBeenCalledTimes(1);
    });
    it("excludes routine signals and bounds bursts per authenticated user", () => {
        const record = createPlaybackDiagnosticRecorder();
        record("user-a", "player.audible_start", {});
        for (let i = 0; i < 100; i++)
            record("user-a", "player.unexpected_stop", {});
        expect(mockWarn).toHaveBeenCalledTimes(60);
        record("user-b", "player.unexpected_stop", {});
        expect(mockWarn).toHaveBeenCalledTimes(61);
    });
});
