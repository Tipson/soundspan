const notifications = new Map<string, any>();
let administrators = [{ id: "admin-a" }, { id: "admin-b" }];
jest.mock("../../utils/db", () => ({
    prisma: {
        user: {
            findMany: jest.fn(async () => administrators),
            findUnique: jest.fn(async () => ({ username: "listener" })),
        },
        notification: {
            createMany: jest.fn(async ({ data }: any) => {
                for (const row of data)
                    if (!notifications.has(row.id))
                        notifications.set(row.id, row);
                return { count: data.length };
            }),
        },
    },
}));
import { recordPlaybackFeedback } from "../playbackFeedback";
describe("playback feedback delivery", () => {
    beforeEach(() => {
        notifications.clear();
        administrators = [{ id: "admin-a" }, { id: "admin-b" }];
    });
    it("creates one private admin notification per recipient despite duplicate delivery", async () => {
        const input = {
            reason: "no_sound",
            reportTrackId: "yt:abc",
            reportTitle: "Song",
            currentTimeSec: 12,
            url: "https://secret",
            token: "secret",
        };
        await recordPlaybackFeedback("listener-id", "report-1", 1000, input);
        await recordPlaybackFeedback("listener-id", "report-1", 1000, input);
        expect(notifications.size).toBe(2);
        expect([...notifications.values()].map((r) => r.userId)).toEqual([
            "admin-a",
            "admin-b",
        ]);
        expect(JSON.stringify([...notifications.values()])).not.toContain(
            "secret",
        );
        expect([...notifications.values()][0]).toMatchObject({
            type: "playback_report",
            metadata: {
                reporterId: "listener-id",
                eventId: "report-1",
                fields: { currentTimeSec: 12 },
            },
        });
    });
    it("does not acknowledge a report when no administrator can receive it", async () => {
        administrators = [];
        await expect(
            recordPlaybackFeedback("listener", "report-1", 1000, {
                reason: "interruption",
                reportTrackId: "yt:abc",
            }),
        ).rejects.toThrow();
        expect(notifications.size).toBe(0);
    });
    it("does not accept arbitrary reasons or missing recording identity", async () => {
        await expect(
            recordPlaybackFeedback("listener", "report-1", 1000, {
                reason: "anything",
            }),
        ).rejects.toThrow();
        expect(notifications.size).toBe(0);
    });
});
