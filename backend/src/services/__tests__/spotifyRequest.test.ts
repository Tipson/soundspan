import axios from "axios";
import { spotifyGetWithDeadline } from "../spotifyRequest";

jest.mock("axios");

const mockAxiosGet = axios.get as jest.Mock;

describe("spotifyGetWithDeadline", () => {
    afterEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    it("aborts a request even when the HTTP adapter never applies its timeout", async () => {
        mockAxiosGet.mockImplementation(
            (_url: string, config: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    config.signal.addEventListener("abort", () => {
                        reject(config.signal.reason);
                    });
                }),
        );

        const request = spotifyGetWithDeadline(
            "https://open.spotify.com/get_access_token",
            { params: { reason: "transport" } },
            20,
        );

        await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://open.spotify.com/get_access_token",
            expect.objectContaining({
                signal: expect.any(AbortSignal),
                timeout: 20,
            }),
        );
    });
});
