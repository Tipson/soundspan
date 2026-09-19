import { AudiusService, normalizeAudiusTrack } from "../audius";

const contentUrl =
    "https://creatornode.audius.co/tracks/cidstream/QmQqUCXvUESsp6j5Dp36n3i679q71UG9UNBMjT376cWRbb?signature=provider-only&skip_play_count=true";

const track = (extra: Record<string, unknown> = {}) => ({
    id: "7AlA9",
    title: "Sinners",
    duration: 237,
    is_streamable: true,
    is_stream_gated: false,
    is_unlisted: false,
    is_delete: false,
    stream_conditions: null,
    access: { stream: true },
    permalink: "/RAC/sinners",
    user: { name: "RAC", handle: "RAC", is_verified: true },
    ...extra,
});

describe("Audius independent catalog", () => {
    it("preserves source identity and attribution without claiming cross-provider equivalence", () => {
        expect(normalizeAudiusTrack(track())).toEqual({
            source: "audius",
            id: "7AlA9",
            title: "Sinners",
            artist: "RAC",
            artistHandle: "RAC",
            artistVerified: true,
            durationSeconds: 237,
            attributionUrl: "https://audius.co/RAC/sinners",
            fullStreamAvailable: true,
            automaticFallbackEligible: false,
            downloadAllowed: false,
        });
        expect(
            normalizeAudiusTrack(track({ title: "Sinners (Cover)" }))?.title,
        ).toBe("Sinners (Cover)");
    });

    it.each([
        { is_streamable: false },
        { is_streamable: undefined },
        { is_stream_gated: true },
        { is_stream_gated: undefined },
        { access: { stream: false } },
        { access: undefined },
        { is_unlisted: true },
        { is_delete: true },
        { stream_conditions: { usdc_purchase: { price: 1 } } },
        { duration: 0 },
        { duration: NaN },
        { duration: Infinity },
        { id: "../admin" },
        { title: "" },
        { user: {} },
        { permalink: "//evil.test/path" },
        { permalink: "/RAC/path?secret=x" },
    ])(
        "rejects unavailable, gated, malformed or unsafe metadata: %j",
        (extra) => {
            expect(normalizeAudiusTrack(track(extra))).toBeNull();
        },
    );

    it("bounds search arguments, filters malformed entries and retains exact versions", async () => {
        const request = jest.fn().mockResolvedValue({
            data: [track(), track({ is_stream_gated: true }), null],
        });
        const service = new AudiusService(request);
        await expect(service.search(" RAC ", 5)).resolves.toHaveLength(1);
        expect(request.mock.calls[0][0]).toBe(
            "/tracks/search?query=RAC&limit=5&app_name=Soundspan",
        );
        await expect(service.search("", 5)).rejects.toMatchObject({
            status: 400,
        });
        await expect(service.search("x", 21)).rejects.toMatchObject({
            status: 400,
        });
        await expect(service.search("x".repeat(201), 5)).rejects.toMatchObject({
            status: 400,
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("revalidates access before each stream and never takes a stream URL from provider metadata", async () => {
        const request = jest
            .fn()
            .mockResolvedValueOnce({
                data: track({ stream_url: "http://127.0.0.1/private" }),
            })
            .mockResolvedValueOnce({ data: contentUrl })
            .mockResolvedValueOnce({ data: track({ is_stream_gated: true }) });
        const service = new AudiusService(request);
        await expect(service.resolveStream("7AlA9")).resolves.toBe(contentUrl);
        await expect(service.resolveStream("7AlA9")).rejects.toMatchObject({
            status: 422,
        });
        await expect(service.resolveStream("../private")).rejects.toMatchObject(
            { status: 400 },
        );
        expect(request).toHaveBeenCalledTimes(3);
    });

    it("rejects an official redirect to an unapproved node before the player sees it", async () => {
        const request = jest
            .fn()
            .mockResolvedValueOnce({ data: track() })
            .mockResolvedValueOnce({
                data: contentUrl.replace(
                    "creatornode.audius.co",
                    "unknown.test",
                ),
            });
        await expect(
            new AudiusService(request).resolveStream("7AlA9"),
        ).rejects.toMatchObject({ status: 422 });
        expect(request.mock.calls[1][2]).toBe("stream-location");
    });

    it("does not accept a different track returned for the requested id", async () => {
        const service = new AudiusService(async () => ({
            data: track({ id: "other" }),
        }));
        await expect(service.resolveStream("7AlA9")).rejects.toMatchObject({
            status: 422,
        });
    });

    it("bounds in-flight metadata work and releases capacity after rejection", async () => {
        const releases: Array<(value: unknown) => void> = [];
        const request = jest.fn(
            () => new Promise((resolve) => releases.push(resolve)),
        );
        const service = new AudiusService(request);
        const pending = Array.from({ length: 4 }, () =>
            service.search("RAC", 1),
        );
        await expect(service.search("RAC", 1)).rejects.toMatchObject({
            status: 503,
        });
        for (const release of releases) release({ data: [] });
        await Promise.all(pending);
        request.mockImplementationOnce(async () => {
            throw new Error("sensitive upstream data");
        });
        await expect(service.search("RAC", 1)).rejects.toMatchObject({
            message: "Audius is temporarily unavailable",
            status: 502,
        });
        request.mockResolvedValueOnce({ data: [] });
        await expect(service.search("RAC", 1)).resolves.toEqual([]);
    });

    it("propagates caller cancellation and rejects an already-cancelled call before I/O", async () => {
        const request = jest
            .fn()
            .mockImplementation(async (_path, signal: AbortSignal) => {
                expect(signal.aborted).toBe(false);
                return { data: [] };
            });
        const service = new AudiusService(request);
        const controller = new AbortController();
        controller.abort();
        await expect(
            service.search("RAC", 1, controller.signal),
        ).rejects.toMatchObject({ status: 499 });
        expect(request).not.toHaveBeenCalled();
        await service.search("RAC", 1);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("distinguishes an expired shared deadline from an actual client cancellation", async () => {
        const request = jest.fn();
        const service = new AudiusService(request);
        const deadline = new AbortController();
        deadline.abort(new DOMException("Deadline expired", "TimeoutError"));
        await expect(
            service.search("RAC", 1, deadline.signal),
        ).rejects.toMatchObject({ status: 502 });
        expect(request).not.toHaveBeenCalled();
        const activeDeadline = new AbortController();
        request.mockImplementationOnce(async () => {
            activeDeadline.abort(
                new DOMException("Deadline expired", "TimeoutError"),
            );
            throw new Error("aborted transport");
        });
        await expect(
            service.search("RAC", 1, activeDeadline.signal),
        ).rejects.toMatchObject({ status: 502 });
    });

    it("cancels active transport and frees the slot without returning partial metadata", async () => {
        const controller = new AbortController();
        let transportAborted = false;
        const request = jest.fn(
            (_path: string, signal: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            transportAborted = true;
                            reject(new Error("transport cancelled"));
                        },
                        { once: true },
                    );
                }),
        );
        const service = new AudiusService(request);
        const pending = service.search("RAC", 1, controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ status: 499 });
        expect(transportAborted).toBe(true);
        request.mockResolvedValueOnce({ data: [] });
        await expect(service.search("RAC", 1)).resolves.toEqual([]);
    });

    it("honors a bounded cooldown after provider throttling instead of retrying", async () => {
        const request = jest.fn().mockRejectedValueOnce({
            isAxiosError: true,
            response: { status: 429 },
        });
        const service = new AudiusService(request);
        await expect(service.search("RAC", 1)).rejects.toMatchObject({
            status: 503,
        });
        await expect(service.search("RAC", 1)).rejects.toMatchObject({
            status: 503,
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([
        {},
        { data: {} },
        { data: Array.from({ length: 101 }, () => track()) },
    ])("rejects malformed or excessive search responses", async (response) => {
        const service = new AudiusService(async () => response);
        await expect(service.search("RAC", 1)).rejects.toMatchObject({
            status: 502,
        });
    });
});
