import { expect } from "@playwright/test";
import { test, TRACKS, login, readAudio, expectPlaying } from "./fixture";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import {
    createSyntheticWav,
    fulfillAudioRange,
} from "../fixtures/syntheticAudio";

// The media clock and decoding are real; only the transport error is injected.
// This does not reproduce Android background restrictions or an upstream outage.
test("explicit resume restores real media time after cancelling source recovery", async ({
    page,
}) => {
    const video = "corevid0001";
    const audio = createSyntheticWav(45);
    const localPath = (path: string) => (url: URL) =>
        url.origin === CORE_ORIGIN && decodeURIComponent(url.pathname) === path;
    await page.route(localPath("/api/personalized/daily-mixes"), (route) =>
        route.fulfill({
            json: {
                mixes: [
                    {
                        key: "core-mix-a",
                        title: "Тестовый микс A",
                        description: "",
                        tracks: [
                            {
                                ...TRACKS[0],
                                youtubeVideoId: video,
                                provider: {
                                    tidalTrackId: null,
                                    youtubeVideoId: video,
                                },
                            },
                        ],
                    },
                ],
            },
        }),
    );
    await page.route(
        localPath(`/api/ytmusic/stream-public/${video}`),
        (route) => fulfillAudioRange(route, audio),
    );
    await page.route(
        localPath(`/api/library/remote-tracks/yt:${video}/preference`),
        (route) =>
            route.fulfill({
                json: { signal: null, liked: false, disliked: false },
            }),
    );
    await page.route(localPath(`/api/lyrics/yt:${video}`), (route) =>
        route.fulfill({
            json: {
                syncedLyrics: null,
                plainLyrics: null,
                source: "none",
                synced: false,
            },
        }),
    );
    let releaseResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
        releaseResolution = resolve;
    });
    let resolutions = 0;
    await page.route(localPath("/api/music-sources/resolve"), async (route) => {
        resolutions += 1;
        await resolutionGate;
        // The browser cancels this request when the listener explicitly pauses.
        await route
            .fulfill({ json: { playback: null } })
            .catch(() => undefined);
    });
    try {
        await login(page);
        await page
            .locator('[data-home-made-card="core-mix-a"]')
            .getByRole("button")
            .click();
        await expectPlaying(page, video);
        await page
            .getByRole("button", { name: "Открыть плеер", exact: true })
            .click();
        for (let attempt = 0; attempt < 4; attempt += 1) {
            await page.evaluate((match) => {
                const elements =
                    (window as Window & { __coreAudio?: HTMLAudioElement[] })
                        .__coreAudio ?? [];
                const element = elements.find(
                    (item) => !item.paused && item.src.includes(match),
                );
                if (!element) throw new Error("No playing native element");
                element.currentTime = 4.96;
                element.dispatchEvent(new Event("timeupdate"));
                Object.defineProperty(element, "error", {
                    configurable: true,
                    value: {
                        code: 2,
                        message: "Synthetic transport interruption",
                    },
                });
                element.dispatchEvent(new Event("error"));
                Reflect.deleteProperty(element, "error");
            }, video);
            if (attempt < 3) await expectPlaying(page, video, 4.96);
        }
        await expect.poll(() => resolutions).toBe(1);
        await page
            .getByRole("button", { name: "Пауза", exact: true })
            .last()
            .click();
        await expect
            .poll(async () => (await readAudio(page, video))?.paused)
            .toBe(true);
        await page
            .getByRole("button", { name: "Воспроизвести", exact: true })
            .last()
            .click();
        await expectPlaying(page, video, 4.96);
        const restored = (await readAudio(page, video))!.time;
        expect(restored).toBeGreaterThanOrEqual(4.96);
        expect(restored).toBeLessThan(10);
        releaseResolution();
        await expectPlaying(page, video, restored);
        expect(resolutions).toBe(1);
    } finally {
        releaseResolution();
    }
});
