import axios from "axios";
import { fetchSpotifyPlaylistViaPartnerApi } from "../spotifyPartner";

jest.mock("axios");

const mockAxiosPost = axios.post as jest.Mock;

function partnerPage(totalCount: number, items: unknown[], offset?: number) {
    return {
        data: {
            data: {
                playlistV2: {
                    __typename: "Playlist",
                    uri: "spotify:playlist:playlist1",
                    name: "Playlist",
                    content: {
                        totalCount,
                        items,
                        pagingInfo:
                            offset === undefined ? undefined : { offset },
                    },
                },
            },
        },
    };
}

describe("fetchSpotifyPlaylistViaPartnerApi", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("fails immediately when Spotify declares tracks but returns an empty first page", async () => {
        mockAxiosPost.mockResolvedValueOnce(partnerPage(10, []));

        await expect(
            fetchSpotifyPlaylistViaPartnerApi("playlist1", "token"),
        ).rejects.toThrow("ended before the declared total");
        expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    });

    it("rejects a truncated later page instead of returning a partial playlist", async () => {
        mockAxiosPost
            .mockResolvedValueOnce(partnerPage(2, [{ itemV2: null }]))
            .mockResolvedValueOnce(partnerPage(2, []));

        await expect(
            fetchSpotifyPlaylistViaPartnerApi("playlist1", "token"),
        ).rejects.toThrow("ended before the declared total");
        expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    });

    it("rejects pagination when Spotify changes the declared total mid-request", async () => {
        mockAxiosPost
            .mockResolvedValueOnce(partnerPage(2, [{ itemV2: null }]))
            .mockResolvedValueOnce(partnerPage(3, [{ itemV2: null }]));

        await expect(
            fetchSpotifyPlaylistViaPartnerApi("playlist1", "token"),
        ).rejects.toThrow("ended before the declared total");
    });

    it("rejects a repeated page offset instead of accepting duplicated items", async () => {
        mockAxiosPost
            .mockResolvedValueOnce(
                partnerPage(2, [{ uid: "item-1", itemV2: null }], 0),
            )
            .mockResolvedValueOnce(
                partnerPage(2, [{ uid: "item-1", itemV2: null }], 0),
            );

        await expect(
            fetchSpotifyPlaylistViaPartnerApi("playlist1", "token"),
        ).rejects.toThrow("unexpected playlist offset");
    });

    it("enforces one absolute deadline across the whole playlist", async () => {
        jest.spyOn(Date, "now")
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(120_001);
        mockAxiosPost.mockResolvedValueOnce(
            partnerPage(2, [{ uid: "item-1", itemV2: null }], 0),
        );

        await expect(
            fetchSpotifyPlaylistViaPartnerApi("playlist1", "token"),
        ).rejects.toThrow("exceeded its total deadline");
        expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-empty playlist when the response contains no importable tracks", async () => {
        mockAxiosPost.mockResolvedValueOnce(
            partnerPage(1, [{ uid: "item-1", itemV2: null }], 0),
        );

        await expect(
            fetchSpotifyPlaylistViaPartnerApi("playlist1", "token"),
        ).rejects.toThrow("no importable tracks");
    });
});
