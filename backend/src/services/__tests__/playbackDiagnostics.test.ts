const mockWarn = jest.fn();
const mockAppend = jest.fn(async (_record: Record<string, unknown>) => {});
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: mockWarn }) },
}));
jest.mock("../playbackDiagnosticJournal", () => ({
    playbackDiagnosticJournal: { append: mockAppend },
}));
import { createPlaybackDiagnosticRecorder } from "../playbackDiagnostics";

describe("playback diagnostic records", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAppend.mockResolvedValue(undefined);
    });
    it("records bounded useful fields at warn level without raw client input", async () => {
        const record = createPlaybackDiagnosticRecorder(() => 100_000);
        await record(
            "user-a",
            "player.unexpected_stop",
            {
                trackId: "yt:track-1",
                sessionId: "account-linked-session",
                playbackRunId: "run-random",
                diagnosticsVersion: 2,
                frontendBuildId: "earlier-client-build",
                sourceKind: "device_file",
                nativePaused: null,
                engineEnded: false,
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
                    playbackRunId: "run-random",
                    diagnosticsVersion: 2,
                    frontendBuildId: "earlier-client-build",
                    sourceKind: "device_file",
                    nativePaused: null,
                    engineEnded: false,
                    currentTimeSec: 83,
                    bufferedAheadSec: 0,
                    online: false,
                    reason: "heartbeat_unexpected_stop",
                },
            }),
        );
        expect(mockAppend).toHaveBeenCalledWith(data);
        expect(mockWarn.mock.calls[0][0]).not.toContain("SECRET");
        expect(JSON.stringify(mockAppend.mock.calls)).not.toContain("track-1");
        expect(JSON.stringify(mockAppend.mock.calls)).not.toContain(
            "account-linked-session",
        );
    });
    it("rejects another account's queued events and deduplicates retries", async () => {
        const record = createPlaybackDiagnosticRecorder(() => 100_000);
        const delivery = {
            id: "event-1",
            ownerId: "user-a",
            observedAtMs: 100_000,
        };
        await record("user-b", "player.unexpected_stop", {}, delivery);
        expect(mockWarn).not.toHaveBeenCalled();
        await record("user-a", "player.unexpected_stop", {}, delivery);
        await record("user-a", "player.unexpected_stop", {}, delivery);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockAppend).toHaveBeenCalledTimes(1);
    });
    it("excludes routine signals and bounds bursts per authenticated user", async () => {
        const record = createPlaybackDiagnosticRecorder();
        await record("user-a", "player.audible_start", {});
        for (let i = 0; i < 100; i++)
            await record("user-a", "player.unexpected_stop", {});
        expect(mockWarn).toHaveBeenCalledTimes(60);
        await record("user-b", "player.unexpected_stop", {});
        expect(mockWarn).toHaveBeenCalledTimes(61);
        expect(mockAppend).not.toHaveBeenCalled();
    });

    it.each([
        "player.engine_pause",
        "player.track_end",
        "player.visibility_change",
    ])("persists the diagnostic context event %s", async (event) => {
        const record = createPlaybackDiagnosticRecorder(() => 100_000);
        await record(
            "user-a",
            event,
            {
                localSource: true,
                diagnosticsVersion: 2,
                readyState: 4,
                networkState: 1,
                mediaErrorCode: null,
                saveData: false,
                connectionType: "4g",
                audioContextState: "not_used",
            },
            {
                id: event.replaceAll(".", ":"),
                ownerId: "user-a",
                observedAtMs: 100_000,
            },
        );
        expect(mockAppend).toHaveBeenCalledTimes(1);
        expect(mockAppend.mock.calls[0][0]).toHaveProperty("fields", {
            localSource: true,
            diagnosticsVersion: 2,
            readyState: 4,
            networkState: 1,
            mediaErrorCode: null,
            saveData: false,
            connectionType: "4g",
            audioContextState: "not_used",
        });
    });

    it("rejects expired, future and unknown queued events without writing", async () => {
        const now = 100_000_000;
        const record = createPlaybackDiagnosticRecorder(() => now);
        for (const observedAtMs of [now - 86_400_000 - 1, now + 60_001]) {
            expect(
                await record(
                    "user-a",
                    "player.unexpected_stop",
                    {},
                    {
                        id: `time-${observedAtMs}`,
                        ownerId: "user-a",
                        observedAtMs,
                    },
                ),
            ).toEqual({ status: "rejected" });
        }
        expect(
            await record(
                "user-a",
                "player.unrecognized",
                {},
                { id: "unknown", ownerId: "user-a", observedAtMs: now },
            ),
        ).toEqual({ status: "rejected" });
        expect(mockAppend).not.toHaveBeenCalled();
    });

    it("reports throttling instead of acknowledging a queued event that was not recorded", async () => {
        let now = 100_000;
        const record = createPlaybackDiagnosticRecorder(() => now);
        for (let i = 0; i < 60; i++)
            await record(
                "user-a",
                "player.unexpected_stop",
                {},
                { id: `event-${i}`, ownerId: "user-a", observedAtMs: now },
            );
        const delivery = {
            id: "retry-after-limit",
            ownerId: "user-a",
            observedAtMs: now,
        };
        expect(
            await record("user-a", "player.unexpected_stop", {}, delivery),
        ).toEqual({ status: "throttled", retryAfterSeconds: 60 });
        expect(mockAppend).toHaveBeenCalledTimes(60);
        now += 60_000;
        expect(
            await record("user-a", "player.unexpected_stop", {}, delivery),
        ).toEqual({ status: "recorded" });
    });

    it("joins concurrent duplicates and only marks an event seen after successful persistent IO", async () => {
        let release!: () => void;
        mockAppend.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const record = createPlaybackDiagnosticRecorder(() => 100_000);
        const delivery = {
            id: "concurrent",
            ownerId: "user-a",
            observedAtMs: 100_000,
        };
        const first = record("user-a", "player.unexpected_stop", {}, delivery);
        const duplicate = record(
            "user-a",
            "player.unexpected_stop",
            {},
            delivery,
        );
        expect(mockAppend).toHaveBeenCalledTimes(1);
        expect(mockWarn).not.toHaveBeenCalled();
        release();
        await Promise.all([first, duplicate]);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        await record("user-a", "player.unexpected_stop", {}, delivery);
        expect(mockAppend).toHaveBeenCalledTimes(1);
    });

    it("does not poison deduplication or quota after failed persistent IO", async () => {
        const record = createPlaybackDiagnosticRecorder(() => 100_000);
        const delivery = {
            id: "failed-then-retried",
            ownerId: "user-a",
            observedAtMs: 100_000,
        };
        mockAppend.mockRejectedValueOnce(new Error("sensitive IO details"));
        expect(
            await record("user-a", "player.unexpected_stop", {}, delivery),
        ).toEqual({ status: "unavailable" });
        expect(mockWarn).not.toHaveBeenCalled();
        expect(
            await record("user-a", "player.unexpected_stop", {}, delivery),
        ).toEqual({ status: "recorded" });
        expect(mockAppend).toHaveBeenCalledTimes(2);
    });

    it("allows the same event to retry after a synchronous storage failure", async () => {
        const record = createPlaybackDiagnosticRecorder(() => 100_000);
        const delivery = {
            id: "sync-failure",
            ownerId: "user-a",
            observedAtMs: 100_000,
        };
        mockAppend.mockImplementationOnce(() => {
            throw new Error("storage failed synchronously");
        });
        expect(
            await record("user-a", "player.unexpected_stop", {}, delivery),
        ).toEqual({ status: "unavailable" });
        expect(
            await record("user-a", "player.unexpected_stop", {}, delivery),
        ).toEqual({ status: "recorded" });
        expect(mockAppend).toHaveBeenCalledTimes(2);
    });

    it("bounds remembered IDs to 128 per user without discarding the latest receipt", async () => {
        let now = 100_000;
        const record = createPlaybackDiagnosticRecorder(() => now);
        for (let i = 0; i < 129; i++) {
            now += 60_000;
            await record(
                "user-a",
                "player.unexpected_stop",
                {},
                { id: `event-${i}`, ownerId: "user-a", observedAtMs: now },
            );
        }
        expect(
            await record(
                "user-a",
                "player.unexpected_stop",
                {},
                { id: "event-128", ownerId: "user-a", observedAtMs: now },
            ),
        ).toEqual({ status: "duplicate" });
        expect(
            await record(
                "user-a",
                "player.unexpected_stop",
                {},
                { id: "event-0", ownerId: "user-a", observedAtMs: now },
            ),
        ).toEqual({ status: "recorded" });
        expect(mockAppend).toHaveBeenCalledTimes(130);
    });

    it("bounds remembered users to 1024 and keeps the most recent account receipt", async () => {
        const record = createPlaybackDiagnosticRecorder(() => 100_000);
        const submit = (ownerId: string) =>
            record(
                ownerId,
                "player.unexpected_stop",
                {},
                { id: "same-anonymous-id", ownerId, observedAtMs: 100_000 },
            );
        for (let i = 0; i < 1025; i++) await submit(`user-${i}`);
        expect(await submit("user-1024")).toEqual({ status: "duplicate" });
        expect(await submit("user-0")).toEqual({ status: "recorded" });
        expect(mockAppend).toHaveBeenCalledTimes(1026);
    });

    it("accepts clock boundaries and excludes malformed or secret-bearing fields", async () => {
        const now = 100_000_000;
        const record = createPlaybackDiagnosticRecorder(() => now);
        for (const observedAtMs of [now - 86_400_000, now + 60_000]) {
            expect(
                await record(
                    "user-a",
                    "player.unexpected_pause",
                    {
                        audioContextState: "interrupted",
                        reason: "https://example.test/SECRET",
                        frontendBuildId: "https://example.test/SECRET",
                        browser: "Agent\nCookie: SECRET",
                        platform: "x".repeat(129),
                        playbackRunId: "run-1",
                        currentTimeSec: Infinity,
                        durationSec: -1,
                        loadId: {},
                        token: "SECRET",
                        nativePaused: null,
                    },
                    {
                        id: `boundary-${observedAtMs}`,
                        ownerId: "user-a",
                        observedAtMs,
                    },
                ),
            ).toEqual({ status: "recorded" });
        }
        expect(mockAppend.mock.calls[0][0].fields).toEqual({
            audioContextState: "interrupted",
            playbackRunId: "run-1",
            nativePaused: null,
        });
        expect(JSON.stringify(mockAppend.mock.calls)).not.toContain("SECRET");
    });

    it("deduplicates delayed retries beyond one hour within the 24-hour window", async () => {
        let now = 100_000;
        const record = createPlaybackDiagnosticRecorder(() => now);
        const delivery = {
            id: "delayed-retry",
            ownerId: "user-a",
            observedAtMs: now,
        };
        await record("user-a", "player.unexpected_stop", {}, delivery);
        now += 6 * 3_600_000;
        await record("user-a", "player.unexpected_stop", {}, delivery);
        expect(mockAppend).toHaveBeenCalledTimes(1);
    });
});
