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
const cid = "QmQqUCXvUESsp6j5Dp36n3i679q71UG9UNBMjT376cWRbb";
const url = `https://creatornode.audius.co/tracks/cidstream/${cid}?signature=provider-only&skip_play_count=true`;
const cdn =
    `https://validator.eeba4a6ca56a0d87af802270217c2a51.r2.cloudflarestorage.com/WRb/${cid}?` +
    new URLSearchParams({
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Checksum-Mode": "ENABLED",
        "X-Amz-Credential": "a".repeat(32) + "/20260905/ENAM/s3/aws4_request",
        "X-Amz-Date": "20260905T135000Z",
        "X-Amz-Expires": "7200",
        "X-Amz-SignedHeaders": "host",
        "X-Amz-Signature": "b".repeat(64),
        "x-id": "GetObject",
    });
const path = "/tracks/7AlA9/stream?app_name=Soundspan";
const destroy = jest.fn();
const redirect = (location: string) => ({
    status: 302,
    headers: { location },
    data: { destroy },
});
const audio = () => ({
    status: 206,
    headers: {
        "content-type": "audio/mpeg",
        "content-range": "bytes 0-0/9471405",
    },
    data: { destroy },
});
beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(resolveSafeOutboundUrl).mockImplementation(
        async (value) => value,
    );
    jest.mocked(resolveSafeOutboundRedirectTarget).mockImplementation(
        async (value) => value,
    );
    jest.mocked(axios.get).mockResolvedValueOnce(redirect(url));
});
it("qualifies direct content audio with Range GET, one signal, no credentials and immediate body disposal", async () => {
    jest.mocked(axios.get).mockResolvedValueOnce(audio());
    const signal = AbortSignal.timeout(8000);
    await expect(resolveAudiusStreamRedirect(path, signal)).resolves.toBe(url);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(axios.head).not.toHaveBeenCalled();
    const calls = jest.mocked(axios.get).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [, options] of calls)
        expect(options).toMatchObject({
            signal,
            proxy: false,
            maxRedirects: 0,
            responseType: "stream",
            headers: { Accept: "audio/*" },
        });
    expect(calls[1][1]?.headers).toEqual({
        Accept: "audio/*",
        Range: "bytes=0-0",
    });
});
it("admits exact signed R2 only after an approved content node, keeping CID identity and three-call budget", async () => {
    jest.mocked(axios.get)
        .mockResolvedValueOnce(redirect(cdn))
        .mockResolvedValueOnce(audio());
    const signal = AbortSignal.timeout(8000);
    await expect(resolveAudiusStreamRedirect(path, signal)).resolves.toBe(cdn);
    expect(destroy).toHaveBeenCalledTimes(3);
    expect(resolveSafeOutboundRedirectTarget).toHaveBeenNthCalledWith(
        1,
        url,
        "https://api.audius.co/v1" + path,
    );
    expect(resolveSafeOutboundRedirectTarget).toHaveBeenNthCalledWith(
        2,
        cdn,
        url,
    );
    for (const [, options] of jest.mocked(axios.get).mock.calls) {
        expect(options?.signal).toBe(signal);
        expect(options?.maxRedirects).toBe(0);
        expect(
            Object.keys(options?.headers ?? {}).every((key) =>
                ["Accept", "Range"].includes(key),
            ),
        ).toBe(true);
    }
});
it.each([
    "https://unknown.storage.test/asset?token=private",
    cdn + "&token=private",
    cdn.replace(cid, "Qm" + "a".repeat(44)),
    url,
])(
    "rejects unsupported secondary destinations before DNS/I/O (%#)",
    async (location) => {
        jest.mocked(axios.get).mockResolvedValueOnce(redirect(location));
        await expect(
            resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
        ).rejects.toMatchObject({ status: 422 });
        expect(axios.get).toHaveBeenCalledTimes(2);
        expect(resolveSafeOutboundRedirectTarget).toHaveBeenCalledTimes(1);
        expect(destroy).toHaveBeenCalledTimes(2);
    },
);
it("does not accept direct official-to-CDN bypass of the content-node trust boundary", async () => {
    jest.mocked(axios.get).mockReset().mockResolvedValueOnce(redirect(cdn));
    await expect(
        resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
    ).rejects.toMatchObject({ status: 422 });
    expect(resolveSafeOutboundRedirectTarget).not.toHaveBeenCalled();
});
it.each([1, 2])("blocks private DNS at transition %i", async (transition) => {
    if (transition === 2) {
        jest.mocked(axios.get).mockResolvedValueOnce(redirect(cdn));
        jest.mocked(resolveSafeOutboundRedirectTarget).mockResolvedValueOnce(
            url,
        );
    }
    jest.mocked(resolveSafeOutboundRedirectTarget).mockResolvedValueOnce(null);
    await expect(
        resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
    ).rejects.toMatchObject({ status: 422 });
    expect(axios.get).toHaveBeenCalledTimes(transition);
});
it.each([
    { status: 200, headers: { "content-type": "audio/mpeg" } },
    {
        status: 206,
        headers: {
            "content-type": "text/html",
            "content-range": "bytes 0-0/99",
        },
    },
    {
        status: 206,
        headers: {
            "content-type": "audio/mpeg",
            "content-range": "bytes 1-1/99",
        },
    },
    {
        status: 206,
        headers: {
            "content-type": "audio/mpeg",
            "content-range": "bytes 0-0/*",
        },
    },
    { status: 302, headers: { location: cdn } },
])(
    "rejects nonqualified terminal responses with no fourth request (%#)",
    async (terminal) => {
        jest.mocked(axios.get)
            .mockResolvedValueOnce(redirect(cdn))
            .mockResolvedValueOnce({ ...terminal, data: { destroy } });
        await expect(
            resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
        ).rejects.toMatchObject({ status: 422 });
        expect(axios.get).toHaveBeenCalledTimes(3);
        expect(destroy).toHaveBeenCalledTimes(3);
    },
);
it("ends stalled secondary DNS on the same deadline without issuing terminal GET", async () => {
    const controller = new AbortController();
    jest.mocked(axios.get).mockResolvedValueOnce(redirect(cdn));
    jest.mocked(resolveSafeOutboundRedirectTarget)
        .mockResolvedValueOnce(url)
        .mockImplementationOnce(() => {
            controller.abort(new DOMException("Timeout", "TimeoutError"));
            return new Promise(() => {});
        });
    await expect(
        resolveAudiusStreamRedirect(path, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(axios.get).toHaveBeenCalledTimes(2);
});
it("sanitizes throttling and destroys the throttled response", async () => {
    jest.mocked(axios.get).mockResolvedValueOnce({
        status: 429,
        headers: {},
        data: { destroy },
    });
    await expect(
        resolveAudiusStreamRedirect(path, AbortSignal.timeout(8000)),
    ).rejects.toMatchObject({
        status: 429,
        message: "Audius media node is unavailable or unsupported",
    });
    expect(destroy).toHaveBeenCalledTimes(2);
});
