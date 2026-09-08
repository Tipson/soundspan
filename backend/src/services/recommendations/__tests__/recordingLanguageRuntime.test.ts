const values = new Map<string, string>();
const mockLookup = jest.fn();
const mockCache = {
    mGet: jest.fn(async (keys: string[]) =>
        keys.map((key) => values.get(key) ?? null),
    ),
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    set: jest.fn(
        async (
            key: string,
            value: string,
            options: { NX?: boolean; EX: number },
        ) => {
            if (options.NX && values.has(key)) return null;
            values.set(key, value);
            return "OK";
        },
    ),
};
const mockRedis = {
    isReady: true,
    withCommandOptions: jest.fn(() => mockCache),
};
jest.mock("../../../utils/redis", () => ({ redisClient: mockRedis }));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ debug: jest.fn() }) },
}));
jest.mock("../recordingLanguageProvider", () => ({
    lookupRecordingLanguage: (...args: unknown[]) => mockLookup(...args),
}));
jest.mock("node:timers/promises", () => ({
    setTimeout: jest.fn(async () => {}),
}));
import { recordingLanguageStore as store } from "../recordingLanguageRuntime";
import { languageCacheKey } from "../recordingLanguage";
const track = {
    title: "Track",
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 200,
};
beforeEach(() => {
    values.clear();
    jest.clearAllMocks();
    mockRedis.isReady = true;
    mockLookup.mockResolvedValue("ru");
});
afterEach(async () => {
    await store.drain();
});
test("shared positive metadata has a TTL and duplicate listeners cause one provider request", async () => {
    await Promise.all(Array.from({ length: 10 }, () => store.prepare([track])));
    await store.drain();
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockCache.set).toHaveBeenCalledWith(languageCacheKey(track), "ru", {
        EX: 30 * 24 * 60 * 60,
    });
    expect((await store.prepare([track])).languages).toEqual(["ru"]);
});
test("a distributed busy slot defers work without a provider retry", async () => {
    values.set("wave:language:lookup-slot", "1");
    await store.prepare([track]);
    await store.drain();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(values.has(languageCacheKey(track))).toBe(false);
});
test("provider throttling opens a shared backoff but never caches unknown language", async () => {
    mockLookup.mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), {
            isAxiosError: true,
            response: { status: 429 },
        }),
    );
    await store.prepare([track]);
    await store.drain();
    expect(values.has(languageCacheKey(track))).toBe(false);
    expect(mockCache.set).toHaveBeenCalledWith(
        "wave:language:provider-backoff",
        "1",
        { EX: 120 },
    );
    await store.prepare([{ ...track, title: "Second" }]);
    await store.drain();
    expect(mockLookup).toHaveBeenCalledTimes(1);
});
test("one slow recording does not block language preparation for other recordings", async () => {
    mockLookup.mockRejectedValueOnce(new Error("timeout"));
    await store.prepare([track]);
    await store.drain();
    expect(values.has("wave:language:provider-backoff")).toBe(false);
    values.delete("wave:language:lookup-slot");
    await store.prepare([track, { ...track, title: "Second" }]);
    await store.drain();
    expect(mockLookup).toHaveBeenCalledTimes(2);
    expect(values.get(languageCacheKey({ ...track, title: "Second" }))).toBe(
        "ru",
    );
    expect(values.has(languageCacheKey(track))).toBe(false);
});
test("offline Redis does not fan out to the lyrics provider", async () => {
    mockRedis.isReady = false;
    expect(await store.prepare([track])).toEqual({
        languages: [null],
        pending: false,
    });
    expect(mockLookup).not.toHaveBeenCalled();
});
