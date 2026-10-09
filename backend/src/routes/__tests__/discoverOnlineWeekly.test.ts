import type { Request, Response } from "express";
jest.mock("../../services/discovery", () => ({
    discoveryRecommendationsService: {
        getCurrentPlaylist: jest.fn(),
        clearCurrentPlaylist: jest.fn(),
    },
}));
jest.mock("../../services/personalWeeklyDiscovery", () => ({
    personalWeeklyDiscoveryService: {
        getCurrent: jest.fn(),
        clearCurrent: jest.fn(),
    },
}));
jest.mock("../../utils/logger", () => ({ logger: { error: jest.fn() } }));
import { discoveryRecommendationsService } from "../../services/discovery";
import { personalWeeklyDiscoveryService } from "../../services/personalWeeklyDiscovery";
import { handleModernCurrent } from "../discover/current";
import { handleModernClear } from "../discover/clear";
const req = { user: { id: "owner" } } as Request;
function response() {
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    return res as unknown as Response;
}
beforeEach(() => jest.clearAllMocks());
it("retains a nonempty local discovery without calling the online catalog", async () => {
    const local = { tracks: [{ id: "local" }] };
    jest.mocked(
        discoveryRecommendationsService.getCurrentPlaylist,
    ).mockResolvedValue(local as never);
    const res = response();
    await handleModernCurrent(req, res);
    expect(res.json).toHaveBeenCalledWith(local);
    expect(personalWeeklyDiscoveryService.getCurrent).not.toHaveBeenCalled();
});
it("serves the authenticated owner's online week when local files are absent", async () => {
    jest.mocked(
        discoveryRecommendationsService.getCurrentPlaylist,
    ).mockResolvedValue({ tracks: [] } as never);
    const week = {
        kind: "online-weekly",
        generationId: "generation",
        tracks: [{ id: "yt:weekly" }],
    };
    jest.mocked(personalWeeklyDiscoveryService.getCurrent).mockResolvedValue(
        week as never,
    );
    const res = response();
    await handleModernCurrent(req, res);
    expect(personalWeeklyDiscoveryService.getCurrent).toHaveBeenCalledWith(
        "owner",
    );
    expect(res.json).toHaveBeenCalledWith(week);
});
it("clear tombstones the online week and reports both local and online removal", async () => {
    jest.mocked(
        discoveryRecommendationsService.clearCurrentPlaylist,
    ).mockResolvedValue({ clearedCount: 3 });
    jest.mocked(personalWeeklyDiscoveryService.clearCurrent).mockResolvedValue(
        40,
    );
    const res = response();
    await handleModernClear(req, res);
    expect(personalWeeklyDiscoveryService.clearCurrent).toHaveBeenCalledWith(
        "owner",
    );
    expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ clearedCount: 43, activeDeleted: 43 }),
    );
});
it("does not leak a failed snapshot lookup to the client", async () => {
    jest.mocked(
        discoveryRecommendationsService.getCurrentPlaylist,
    ).mockResolvedValue({ tracks: [] } as never);
    jest.mocked(personalWeeklyDiscoveryService.getCurrent).mockRejectedValue(
        new Error("private database endpoint"),
    );
    const res = response();
    await handleModernCurrent(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
        error: "Failed to get Discover Weekly playlist",
    });
});
