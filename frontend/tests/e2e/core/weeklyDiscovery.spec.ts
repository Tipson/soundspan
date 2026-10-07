import { expect } from "@playwright/test";
import { test, login, expectPlaying } from "./fixture";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import {
    createSyntheticWav,
    fulfillAudioRange,
} from "../fixtures/syntheticAudio";

test("online weekly discoveries keep a 40-track queue, source and play attribution", async ({
    page,
}) => {
    const generation = "weekly-fixture-generation";
    const tracks = Array.from({ length: 40 }, (_, i) => ({
        id: `yt:weekly-${i}`,
        youtubeVideoId: `weekly-${i}`,
        title: `Открытие ${String(i + 1).padStart(2, "0")}`,
        artist: `Артист ${Math.floor(i / 2)}`,
        album: "Альбом",
        albumId: "weekly-album",
        duration: 45,
        coverUrl: null,
        sourceType: "youtube",
        streamSource: "youtube",
        available: true,
        isLiked: false,
        likedAt: null,
        similarity: 0,
        tier: "explore",
        recommendationGenerationId: generation,
    }));
    const playlist = {
        kind: "online-weekly",
        generationId: generation,
        weekStart: "2026-10-05T00:00:00.000Z",
        weekEnd: "2026-10-11T23:59:59.999Z",
        tracks,
        unavailable: [],
        totalCount: 40,
        count: 40,
        unavailableCount: 0,
    };
    const localPath = (path: string) => (url: URL) =>
        url.origin === CORE_ORIGIN && decodeURIComponent(url.pathname) === path;
    await page.route(localPath("/api/system/features"), (route) =>
        route.fulfill({
            json: {
                discovery: true,
                audioAnalysis: true,
                musicCNN: false,
                vibeEmbeddings: false,
                autoPlaylists: false,
                federation: false,
            },
        }),
    );
    await page.route(localPath("/api/discover/current"), (route) =>
        route.fulfill({ json: playlist }),
    );
    await page.route(localPath("/api/discover/config"), (route) =>
        route.fulfill({
            json: {
                enabled: true,
                playlistSize: 30,
                exclusionMonths: 3,
                downloadRatio: 1.5,
                lastGeneratedAt: null,
            },
        }),
    );
    await page.route(localPath("/api/discover/batch-status"), (route) =>
        route.fulfill({ json: { active: false, status: null } }),
    );
    await page.route(
        localPath("/api/library/cover-art/weekly-album"),
        (route) => route.fulfill({ status: 404, body: "No synthetic artwork" }),
    );
    await page.route(
        localPath("/api/social/profile-picture/core-user"),
        (route) => route.fulfill({ status: 404, body: "No synthetic avatar" }),
    );
    await page.route(
        (url) =>
            url.origin === CORE_ORIGIN &&
            /^\/api\/ytmusic\/stream-info-public\/weekly-\d+$/.test(
                url.pathname,
            ),
        (route) =>
            route.fulfill({ status: 404, json: { error: "Stream not found" } }),
    );
    const audio = createSyntheticWav(45);
    await page.route(
        (url) =>
            url.origin === CORE_ORIGIN &&
            /^\/api\/ytmusic\/stream-public\/weekly-\d+$/.test(url.pathname),
        (route) => fulfillAudioRange(route, audio),
    );
    await page.route(
        (url) =>
            url.origin === CORE_ORIGIN &&
            /^\/api\/library\/remote-tracks\/yt:weekly-\d+\/preference$/.test(
                decodeURIComponent(url.pathname),
            ),
        (route) =>
            route.fulfill({
                json: { signal: null, liked: false, disliked: false },
            }),
    );
    await page.route(
        (url) =>
            url.origin === CORE_ORIGIN &&
            /^\/api\/lyrics\/yt:weekly-\d+$/.test(
                decodeURIComponent(url.pathname),
            ),
        (route) =>
            route.fulfill({
                json: {
                    syncedLyrics: null,
                    plainLyrics: null,
                    source: "none",
                    synced: false,
                },
            }),
    );
    const plays: Array<{ recommendationGenerationId?: string }> = [];
    await page.route(localPath("/api/plays"), (route) => {
        plays.push(route.request().postDataJSON());
        return route.fallback();
    });
    await login(page);
    await page.goto("/discover");
    await expect(page.getByText(/^Открытие \d{2}$/)).toHaveCount(40);
    await expect(
        page.getByRole("button", { name: "Настройки", exact: true }),
    ).toHaveCount(0);
    await expect(
        page.getByRole("button", { name: "Собрать заново", exact: true }),
    ).toHaveCount(0);
    await page
        .getByRole("button", { name: "Воспроизвести всё", exact: true })
        .click();
    await expectPlaying(page, "weekly-0");
    await expect
        .poll(() =>
            page.evaluate(() =>
                JSON.parse(localStorage.getItem("soundspan_queue") ?? "[]").map(
                    (track: {
                        id: string;
                        streamSource?: string;
                        recommendationGenerationId?: string;
                    }) => [
                        track.id,
                        track.streamSource,
                        track.recommendationGenerationId,
                    ],
                ),
            ),
        )
        .toEqual(tracks.map((track) => [track.id, "youtube", generation]));
    await expect
        .poll(() =>
            plays.some(
                (play) => play.recommendationGenerationId === generation,
            ),
        )
        .toBe(true);
    await page
        .getByRole("button", { name: "Открыть плеер", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Следующий трек", exact: true })
        .last()
        .click();
    await expectPlaying(page, "weekly-1");
    await page
        .getByRole("button", { name: "Свернуть плеер", exact: true })
        .click();
    await page.screenshot({
        path: "output/playwright/core/weekly-mobile.png",
        fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await expect(page.getByText("Открытие 40", { exact: true })).toBeVisible();
    await page.screenshot({
        path: "output/playwright/core/weekly-desktop.png",
        fullPage: true,
    });
});
