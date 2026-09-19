import axios from "axios";
import {
    resolveSafeOutboundUrl,
    resolveSafeOutboundRedirectTarget,
} from "../outboundUrlSafety";
import { resolveAudiusStreamRedirect } from "../audiusStream";
jest.mock("axios", () => ({
    __esModule: true,
    default: { get: jest.fn(), head: jest.fn() },
}));
jest.mock("../outboundUrlSafety", () => ({
    resolveSafeOutboundUrl: jest.fn(),
    resolveSafeOutboundRedirectTarget: jest.fn(),
}));
const url =
    "https://creatornode.audius.co/tracks/cidstream/QmQqUCXvUESsp6j5Dp36n3i679q71UG9UNBMjT376cWRbb?signature=provider-only&skip_play_count=true";
const path = "/tracks/7AlA9/stream?app_name=Soundspan";
const destroy = jest.fn();
beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(resolveSafeOutboundUrl).mockImplementation(
        async (value) => value,
    );
    jest.mocked(resolveSafeOutboundRedirectTarget).mockImplementation(
        async (value) => value,
    );
    jest.mocked(axios.get).mockResolvedValueOnce({
        status: 302,
        headers: { location: url },
        data: { destroy },
    });
});
it("returns only terminal supported audio, preserving one signal and never following automatically", async () => {
    jest.mocked(axios.get).mockResolvedValueOnce({
        status: 206,
        headers: {
            "content-type": "audio/mpeg",
            "content-range": "bytes 0-0/99",
        },
        data: { destroy },
    });
    const signal = AbortSignal.timeout(8000);
    await expect(resolveAudiusStreamRedirect(path, signal)).resolves.toBe(url);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(axios.get).toHaveBeenCalledWith(
        "https://api.audius.co/v1" + path,
        expect.objectContaining({
            signal,
            proxy: false,
            maxRedirects: 0,
            responseType: "stream",
        }),
    );
    expect(resolveSafeOutboundRedirectTarget).toHaveBeenCalledWith(
        url,
        "https://api.audius.co/v1" + path,
    );
    for (const [, options] of jest.mocked(axios.get).mock.calls)
        expect(options).toMatchObject({
            signal,
            proxy: false,
            maxRedirects: 0,
        });
});
it("blocks unknown storage redirects before DNS/I/O and never returns a nonterminal node", async () => {
    jest.mocked(axios.get).mockResolvedValueOnce({
        status: 302,
        headers: {
            location: "https://unknown.storage.test/asset?token=private",
        },
    });
    await expect(
        resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
    ).rejects.toMatchObject({ status: 422 });
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(resolveSafeOutboundRedirectTarget).toHaveBeenCalledTimes(1);
});
it("blocks private DNS results before following a permitted hostname", async () => {
    jest.mocked(resolveSafeOutboundRedirectTarget).mockResolvedValueOnce(null);
    await expect(
        resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
    ).rejects.toMatchObject({ status: 422 });
    expect(axios.head).not.toHaveBeenCalled();
});
it("rejects content-node redirect loops and HTML instead of admitting them as audio", async () => {
    jest.mocked(axios.get).mockResolvedValueOnce({
        status: 302,
        headers: { location: url },
    });
    await expect(
        resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
    ).rejects.toMatchObject({ status: 422 });
    expect(axios.get).toHaveBeenCalledTimes(2);
    jest.mocked(axios.get)
        .mockReset()
        .mockResolvedValueOnce({
            status: 302,
            headers: { location: url },
            data: { destroy },
        })
        .mockResolvedValueOnce({
            status: 200,
            headers: { "content-type": "text/html" },
        });
    await expect(
        resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
    ).rejects.toMatchObject({ status: 422 });
});
it("ends a stalled DNS check on the shared cancellation signal without starting HEAD", async () => {
    const controller = new AbortController();
    jest.mocked(resolveSafeOutboundUrl).mockReturnValue(new Promise(() => {}));
    const pending = resolveAudiusStreamRedirect(path, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(axios.head).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
});

it("blocks an unknown origin before DNS and destroys unexpected official bodies", async () => {
    jest.mocked(axios.get)
        .mockReset()
        .mockResolvedValueOnce({
            status: 302,
            headers: { location: "http://127.0.0.1/private" },
            data: { destroy },
        });
    await expect(
        resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
    ).rejects.toMatchObject({ status: 422 });
    expect(resolveSafeOutboundRedirectTarget).not.toHaveBeenCalled();
    expect(axios.head).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
});
