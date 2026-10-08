import { expect } from "@playwright/test";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import { test, login, expectPlaying, readAudio } from "./fixture";
import {
    createSyntheticWav,
    fulfillAudioRange,
} from "../fixtures/syntheticAudio";

test("direct liked recordings play, retain feedback in both players, and advance only after a confirmed dislike", async ({
    page,
}) => {
    const rows = (["vk", "yandex"] as const).map((provider, index) => {
        const nativeId = index === 0 ? "-1_2" : "0007";
        return {
            id: `${provider}:${nativeId}`,
            title: `Прямой трек ${index + 1}`,
            duration: 45,
            trackNo: null,
            filePath: null,
            likedAt: "2026-10-08T09:00:00Z",
            source: provider,
            streamSource: provider,
            provider: {
                source: provider,
                providerTrackId: nativeId,
                youtubeVideoId: null,
                tidalTrackId: null,
            },
            artist: { id: null, name: "Тестовый артист" },
            album: { id: null, title: "", coverArt: null },
            musicSourceRecording: {
                provider,
                id: nativeId,
                title: `Прямой трек ${index + 1}`,
                artists: ["Тестовый артист", "Гость"],
                duration: 45,
                contentVersion: "clean",
                preview: false,
            },
        };
    });
    const signals = new Map(rows.map((row) => [row.id, "thumbs_up"]));
    const mutations: Array<{ id: string; signal: string; failed: boolean }> =
        [];
    let rejectNextDislike = true;
    const path = (value: string) => (url: URL) =>
        url.origin === CORE_ORIGIN &&
        decodeURIComponent(url.pathname) === value;
    await page.route(path("/api/library/liked"), (route) =>
        route.fulfill({
            json: {
                playlist: {
                    id: "my-liked",
                    name: "Любимые треки",
                    description: "",
                },
                tracks: rows.filter(
                    (row) => signals.get(row.id) === "thumbs_up",
                ),
                total: rows.length,
                pagination: { limit: 100, hasMore: false, nextCursor: null },
            },
        }),
    );
    for (const row of rows) {
        await page.route(
            path(`/api/library/remote-tracks/${row.id}/preference`),
            async (route) => {
                if (route.request().method() === "POST") {
                    const signal = route.request().postDataJSON()
                        .signal as string;
                    const failed =
                        signal === "thumbs_down" && rejectNextDislike;
                    mutations.push({ id: row.id, signal, failed });
                    if (failed) {
                        rejectNextDislike = false;
                        return route.fulfill({
                            status: 500,
                            json: { error: "Fixture save failed" },
                        });
                    }
                    signals.set(row.id, signal);
                }
                const signal = signals.get(row.id)!;
                return route.fulfill({
                    json: {
                        trackId: row.id,
                        signal,
                        score:
                            signal === "thumbs_up"
                                ? 1
                                : signal === "thumbs_down"
                                  ? -1
                                  : 0,
                        isLiked: signal === "thumbs_up",
                        isDisliked: signal === "thumbs_down",
                        likedAt: signal === "thumbs_up" ? row.likedAt : null,
                        dislikedAt:
                            signal === "thumbs_down" ? row.likedAt : null,
                        updatedAt: row.likedAt,
                    },
                });
            },
        );
        await page.route(path(`/api/lyrics/${row.id}`), (route) =>
            route.fulfill({
                json: {
                    syncedLyrics: null,
                    plainLyrics: null,
                    source: "none",
                    synced: false,
                },
            }),
        );
        await page.route(path(`/api/vibe/similar/${row.id}`), (route) =>
            route.fulfill({ json: { tracks: [] } }),
        );
    }
    const leases = ["a".repeat(48), "b".repeat(48)];
    const preloadedSecondSource =
        "/api/music-sources/recordings/yandex/0007/stream";
    const audio = createSyntheticWav(45);
    await page.route(path("/api/music-sources/resolve"), (route) => {
        const input = route.request().postDataJSON();
        const index = rows.findIndex(
            (row) =>
                row.source === input.provider &&
                row.provider.providerTrackId === input.providerTrackId,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        expect(input.artists).toEqual(["Тестовый артист", "Гость"]);
        expect(input.contentVersion).toBe("clean");
        return route.fulfill({
            json: {
                playback: {
                    provider: rows[index].source,
                    leaseId: leases[index],
                    streamPath: `/api/music-sources/leases/${leases[index]}/stream`,
                },
            },
        });
    });
    for (const [index, row] of rows.entries()) {
        await page.route(
            path(`/api/music-sources/leases/${leases[index]}/stream`),
            (route) => fulfillAudioRange(route, audio),
        );
        await page.route(
            path(
                `/api/music-sources/recordings/${row.source}/${row.provider.providerTrackId}/stream`,
            ),
            (route) => fulfillAudioRange(route, audio),
        );
    }
    await login(page);
    await page.goto("/playlist/my-liked");
    await expect(page.getByText(rows[0].title, { exact: true })).toBeVisible();
    await page
        .getByRole("button", { name: "Воспроизвести всё", exact: true })
        .click();
    await expectPlaying(page, leases[0]);
    const dock = page.locator('[data-mobile-player="dock"]');
    await expect(
        dock.getByRole("button", {
            name: "Убрать отметку «Нравится»",
            exact: true,
        }),
    ).toBeVisible();
    await expect(
        dock.getByRole("button", { name: "Не нравится", exact: true }),
    ).toBeVisible();
    const queue = () =>
        page.evaluate(() =>
            JSON.parse(localStorage.getItem("soundspan_queue") ?? "[]"),
        );
    await expect
        .poll(async () =>
            (await queue()).map((track: { id: string }) => track.id),
        )
        .toEqual(rows.map((row) => row.id));
    expect((await queue())[0].musicSourceRecording.artists).toEqual([
        "Тестовый артист",
        "Гость",
    ]);
    await dock
        .getByRole("button", { name: "Не нравится", exact: true })
        .click();
    await expect.poll(() => mutations.some((row) => row.failed)).toBe(true);
    await expect(
        dock.getByRole("button", { name: "Не нравится", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await expectPlaying(page, leases[0]);
    expect(await readAudio(page, leases[1])).toBeNull();
    await page
        .getByRole("button", { name: "Открыть плеер", exact: true })
        .click();
    const overlay = page.locator(".overlay-player-stage");
    await expect(
        overlay.getByRole("button", { name: "Не нравится", exact: true }),
    ).toHaveCount(1);
    await expect(
        overlay.getByRole("button", {
            name: "Убрать отметку «Нравится»",
            exact: true,
        }),
    ).toHaveCount(1);
    await overlay
        .getByRole("button", { name: "Не нравится", exact: true })
        .click();
    await expect
        .poll(() =>
            mutations.some(
                (row) =>
                    row.id === rows[0].id &&
                    row.signal === "thumbs_down" &&
                    !row.failed,
            ),
        )
        .toBe(true);
    await expectPlaying(page, preloadedSecondSource);
    await page
        .getByRole("button", { name: "Свернуть плеер", exact: true })
        .click();
    await expect(dock).toBeVisible();
    await expect(
        dock.getByRole("button", {
            name: "Убрать отметку «Нравится»",
            exact: true,
        }),
    ).toBeVisible();
    await dock
        .getByRole("button", { name: "Убрать отметку «Нравится»", exact: true })
        .click();
    await expect
        .poll(() =>
            mutations.some(
                (row) => row.id === rows[1].id && row.signal === "clear",
            ),
        )
        .toBe(true);
    await expect(
        dock.getByRole("button", { name: "Нравится", exact: true }),
    ).toBeVisible();
    await expectPlaying(page, preloadedSecondSource);
});
