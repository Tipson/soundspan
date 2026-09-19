const isLidarrEnabled = jest.fn();
const isSoulseekAvailable = jest.fn();
const isYoutubeAvailable = jest.fn();

jest.mock("../lidarr", () => ({
    lidarrService: { isEnabled: isLidarrEnabled },
}));
jest.mock("../soulseek", () => ({
    soulseekService: { isAvailable: isSoulseekAvailable },
}));
jest.mock("../youtubeDownload", () => ({
    youtubeDownloadService: { isAvailable: isYoutubeAvailable },
}));

import {
    probeDownloadSourceAvailability,
    resolveDownloadSource,
} from "../downloadSourcePolicy";

const availability = {
    lidarr: true,
    soulseek: true,
    youtube: true,
};

describe("probeDownloadSourceAvailability", () => {
    it("probes only supported sources", async () => {
        isLidarrEnabled.mockResolvedValueOnce(true);
        isSoulseekAvailable.mockResolvedValueOnce(false);
        isYoutubeAvailable.mockResolvedValueOnce(true);

        await expect(probeDownloadSourceAvailability()).resolves.toEqual({
            lidarr: true,
            soulseek: false,
            youtube: true,
        });
    });
});

describe("resolveDownloadSource", () => {
    it.each(["lidarr", "soulseek", "youtube"] as const)(
        "dispatches an available configured %s source",
        (source) => {
            expect(
                resolveDownloadSource({
                    configuredSource: source,
                    fallback: "none",
                    availability,
                }),
            ).toEqual({ kind: "dispatch", source });
        },
    );

    it("dispatches youtube as an available explicit fallback", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "lidarr",
                fallback: "youtube",
                availability: { ...availability, lidarr: false },
            }),
        ).toEqual({ kind: "dispatch", source: "youtube" });
    });

    it("fails when the selected fallback is unavailable", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "youtube",
                fallback: "lidarr",
                availability: {
                    ...availability,
                    youtube: false,
                    lidarr: false,
                },
            }),
        ).toEqual({
            kind: "fail",
            statusText: "youtube and fallback lidarr unavailable",
            error: "youtube is unavailable and the configured fallback (lidarr) is also unavailable",
        });
    });

    it("uses a supported legacy fallback when no preference is stored", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "youtube",
                fallback: undefined,
                availability: { ...availability, youtube: false },
            }),
        ).toEqual({ kind: "dispatch", source: "soulseek" });
    });

    it("preserves the configured source when every source is unavailable", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "youtube",
                fallback: null,
                availability: {
                    soulseek: false,
                    lidarr: false,
                    youtube: false,
                },
            }),
        ).toEqual({ kind: "dispatch", source: "youtube" });
    });
});
