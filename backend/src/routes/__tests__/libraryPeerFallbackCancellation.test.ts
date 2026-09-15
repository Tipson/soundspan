import type { Request, Response } from "express";

const mockLoadFallback = jest.fn();
const mockServeProvider = jest.fn();
const mockWarn = jest.fn();
const mockSendError = jest.fn();
jest.mock("../../services/peerPlaybackFallback", () => ({
    loadPeerPlaybackFallback: mockLoadFallback,
}));
jest.mock("../../services/mappedProviderStream", () => ({
    serveMappedProviderStream: mockServeProvider,
    mappedProviderResponseState: () => ({
        headersSent: false,
        destroyed: false,
        writableEnded: false,
    }),
    isMappedProviderResponseUnusable: () => false,
    terminateCommittedStream: jest.fn(),
}));
jest.mock("../../services/federationStreamProxy", () => ({
    proxyFederatedTrackStream: jest.fn(),
}));
jest.mock("../youtubeMusic", () => ({
    getUserIdOrPublic: async () => "__public__",
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: mockWarn }) },
}));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../utils/libraryAudioInfo", () => ({
    normalizeStreamingQuality: () => "high",
}));
jest.mock("../../utils/routeErrorResponse", () => ({
    sendRouteError: mockSendError,
}));

import { applyLibraryPeerFallback } from "../library/libraryPeerStream";

it("ends the web peer fallback ladder quietly when the listener cancels", async () => {
    mockLoadFallback.mockResolvedValue([
        { source: "ytmusic", youtubeVideoId: "first" },
        { source: "ytmusic", youtubeVideoId: "second" },
    ]);
    mockServeProvider.mockResolvedValue({ status: "cancelled" });
    const result = await applyLibraryPeerFallback({
        req: { headers: {} } as Request<{ id: string }>,
        res: {} as Response,
        userId: "user",
        trackId: "track",
        quality: "high",
    });
    expect(result).toBeNull();
    expect(mockServeProvider).toHaveBeenCalledTimes(1);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockSendError).not.toHaveBeenCalled();
});
