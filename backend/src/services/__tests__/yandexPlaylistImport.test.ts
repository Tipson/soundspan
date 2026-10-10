const mockJson = jest.fn();
jest.mock("../musicSources/transport", () => ({
    musicSourceHttp: { json: mockJson },
}));
import {
    fetchYandexPlaylistForImport,
    YandexPlaylistImportError,
} from "../yandexPlaylistImport";
import { MusicSourceError } from "../musicSources/types";

describe("public Yandex playlist metadata boundary", () => {
    beforeEach(() => jest.resetAllMocks());

    it("accepts an empty public playlist", async () => {
        mockJson.mockResolvedValue({
            result: {
                title: "Empty",
                visibility: "public",
                trackCount: 0,
                tracks: [],
            },
        });
        await expect(fetchYandexPlaylistForImport("fan:1")).resolves.toEqual({
            name: "Empty",
            tracks: [],
        });
    });

    it.each(["../fan:1", "fan:1/../../", "https://evil.test", "fan:1:extra"])(
        "rejects invalid stored identifiers before HTTP: %s",
        async (id) => {
            await expect(fetchYandexPlaylistForImport(id)).rejects.toThrow(
                YandexPlaylistImportError,
            );
            expect(mockJson).not.toHaveBeenCalled();
        },
    );

    it.each([
        "auth_required",
        "entitlement_required",
        "rate_limit",
        "unavailable",
    ] as const)(
        "sanitizes %s and never returns upstream errors",
        async (code) => {
            mockJson.mockRejectedValue(new MusicSourceError(code));
            try {
                await fetchYandexPlaylistForImport("fan:1");
                throw new Error("expected failure");
            } catch (error) {
                expect(error).toBeInstanceOf(YandexPlaylistImportError);
                expect(
                    (error as YandexPlaylistImportError).providerFailure,
                ).toBe(code === "unavailable");
                expect((error as Error).message).not.toContain("OAuth");
            }
        },
    );

    it.each([
        { result: [] },
        {
            result: [
                {
                    id: "2",
                    title: "Wrong recording",
                    artists: [{ name: "Artist" }],
                },
            ],
        },
        { result: [{ id: "1", title: "Malformed credit", artists: [] }] },
    ])(
        "refuses a missing, substituted, or malformed batch instead of dropping positions",
        async ({ result }) => {
            mockJson
                .mockResolvedValueOnce({
                    result: {
                        title: "One",
                        visibility: "public",
                        trackCount: 1,
                        tracks: [{ id: "1" }],
                    },
                })
                .mockResolvedValueOnce({ result });
            await expect(
                fetchYandexPlaylistForImport("fan:1"),
            ).rejects.toMatchObject({ code: "incomplete" });
        },
    );

    it("stops a cancelled read before querying the provider", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            fetchYandexPlaylistForImport("fan:1", controller.signal),
        ).rejects.toThrow();
        expect(mockJson).not.toHaveBeenCalled();
    });

    it("never follows a provider-supplied continuation link or accepts a partial snapshot", async () => {
        mockJson.mockResolvedValueOnce({
            result: {
                title: "Partial",
                visibility: "public",
                trackCount: 2,
                tracks: [{ id: "1" }],
                next: "http://127.0.0.1/private",
            },
        });
        await expect(
            fetchYandexPlaylistForImport("fan:1"),
        ).rejects.toMatchObject({ code: "incomplete" });
        expect(mockJson).toHaveBeenCalledTimes(1);
    });
});
