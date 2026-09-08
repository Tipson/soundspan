import { RecordingLanguageStore } from "../recordingLanguageStore";
import {
    languageCacheKey,
    type LanguageRecording,
    type RecordingLanguage,
} from "../recordingLanguage";

const track = (id: number): LanguageRecording => ({
    title: `Track ${id}`,
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 200,
});
function setup() {
    const cache = new Map<string, RecordingLanguage>();
    const deps = {
        read: jest.fn(async (keys: string[]) =>
            keys.map((key) => cache.get(key) ?? null),
        ),
        fill: jest.fn(async (_track: LanguageRecording) => {}),
        warn: jest.fn(),
    };
    return { cache, deps, store: new RecordingLanguageStore(deps) };
}
describe("bounded recording language preparation", () => {
    it("does not strand work arriving as the previous fill completes", async () => {
        const { store, deps } = setup();
        let next: Promise<unknown> | undefined;
        deps.fill.mockImplementationOnce(async () => {
            queueMicrotask(() => {
                next = store.prepare([track(2)]);
            });
        });
        await store.prepare([track(1)]);
        await next;
        await store.drain();
        expect(deps.fill.mock.calls.map(([value]) => value.title)).toEqual([
            "Track 1",
            "Track 2",
        ]);
    });
    it("reads a batch without waiting for external lyrics", async () => {
        const { store, deps, cache } = setup();
        cache.set(languageCacheKey(track(1)), "ru");
        let finish!: () => void;
        deps.fill.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const result = await store.prepare([track(1), track(2)]);
        expect(result.languages).toEqual(["ru", null]);
        expect(result.pending).toBe(true);
        expect(deps.fill).toHaveBeenCalledTimes(1);
        finish();
        await store.drain();
    });
    it("coalesces callers and caps background work", async () => {
        const { store, deps } = setup();
        let finish!: () => void;
        deps.fill.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const tracks = Array.from({ length: 100 }, (_, i) => track(i));
        await Promise.all(
            Array.from({ length: 10 }, () => store.prepare(tracks)),
        );
        expect(deps.fill).toHaveBeenCalledTimes(1);
        finish();
        await store.drain();
        expect(deps.fill.mock.calls.length).toBeLessThanOrEqual(64);
        expect(
            new Set(
                deps.fill.mock.calls.map(([value]) => languageCacheKey(value)),
            ).size,
        ).toBe(deps.fill.mock.calls.length);
    });
    it("does not start provider work on cache failure and observes fill failures", async () => {
        const { store, deps } = setup();
        deps.read.mockRejectedValueOnce(new Error("cache offline"));
        expect(await store.prepare([track(1)])).toEqual({
            languages: [null],
            pending: false,
        });
        expect(deps.fill).not.toHaveBeenCalled();
        deps.fill.mockRejectedValue(new Error("lyrics timeout"));
        await store.prepare([track(1)]);
        await store.drain();
        expect(deps.warn).toHaveBeenCalledTimes(2);
    });
});
