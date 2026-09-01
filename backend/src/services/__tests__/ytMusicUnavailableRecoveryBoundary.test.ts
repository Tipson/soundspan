const mockClient = {
    get: jest.fn(),
    post: jest.fn(),
};

jest.mock("../../config", () => ({
    config: {
        internalApiSecret: undefined,
        ytmusicStreamer: { url: "http://127.0.0.1:8586" },
    },
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: jest.fn(() => mockClient),
    },
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../utils/logger", () => ({ logger: mockLogger }));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../trackMappingService", () => ({
    trackMappingService: { ensureRemoteTrack: jest.fn() },
}));

import { ytMusicService } from "../youtubeMusic";
import {
    createYtMusicUnavailableRecoveryService,
    type YtMusicUnavailableRecoveryDependencies,
} from "../ytMusicUnavailableRecovery";

const original = {
    originalVideoId: "z0NfI2NeDHI",
    artist: "Rammstein",
    title: "Radio (Official Video)",
    albumTitle: "Rammstein",
    duration: 275,
};

const createBoundaryDependencies = () => {
    const dependencies: jest.Mocked<YtMusicUnavailableRecoveryDependencies> = {
        getStreamInfo: jest.fn((videoId: string) =>
            ytMusicService.getStreamInfo("__public__", videoId, undefined, {
                timeoutMs: 15_000,
                maxRetries: 0,
            }),
        ),
        findPlayableAlternate: jest.fn().mockResolvedValue(null),
        ensureRemoteTrack: jest.fn(),
        persistPlaylistReplacement: jest.fn(),
    };
    return dependencies;
};

describe("YT Music unavailable recovery sidecar status boundary", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("starts alternate search when the sidecar returns exact HTTP 404", async () => {
        mockClient.get.mockRejectedValueOnce({ response: { status: 404 } });
        const dependencies = createBoundaryDependencies();
        const service = createYtMusicUnavailableRecoveryService(dependencies);

        await expect(service.recover("user-1", original)).resolves.toEqual({
            status: "no_candidate",
            originalVideoId: original.originalVideoId,
            replacement: null,
            persisted: false,
        });

        expect(mockClient.get).toHaveBeenCalledWith(
            `/stream/${original.originalVideoId}`,
            {
                params: { user_id: "__public__" },
                timeout: 15_000,
            },
        );
        expect(dependencies.findPlayableAlternate).toHaveBeenCalledTimes(1);
    });

    it("rethrows transient HTTP 502 without starting alternate search", async () => {
        const upstreamError = { response: { status: 502 } };
        mockClient.get.mockRejectedValueOnce(upstreamError);
        const dependencies = createBoundaryDependencies();
        const service = createYtMusicUnavailableRecoveryService(dependencies);

        await expect(service.recover("user-1", original)).rejects.toBe(
            upstreamError,
        );

        expect(mockClient.get).toHaveBeenCalledTimes(1);
        expect(dependencies.findPlayableAlternate).not.toHaveBeenCalled();
    });
});
