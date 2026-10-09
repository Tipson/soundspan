import { expect, type Page } from "@playwright/test";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import { test, login, expectPlaying, readAudio } from "./fixture";
import {
    createSyntheticWav,
    fulfillAudioRange,
} from "../fixtures/syntheticAudio";

function tracks(provider: "vk" | "yandex", count: number) {
    return Array.from({ length: count }, (_, index) => {
        const rawId =
            provider === "vk" ? `-001_${index + 1}` : `000${index + 1}`;
        const recording = {
            provider,
            id: rawId,
            title: `Personal ${provider} ${index + 1}`,
            artists: ["First", "Guest"],
            duration: 45,
            contentVersion: "clean" as const,
            preview: false as const,
        };
        return {
            id: `${provider}:${rawId}`,
            title: recording.title,
            duration: 45,
            trackNo: null,
            source: provider,
            streamSource: provider,
            artist: { id: null, name: "First, Guest" },
            album: { id: null, title: "", coverArt: null },
            provider: {
                source: provider,
                providerTrackId: rawId,
                youtubeVideoId: null,
                tidalTrackId: null,
            },
            musicSourceRecording: recording,
        };
    });
}
const path = (value: string) => (url: URL) =>
    url.origin === CORE_ORIGIN && decodeURIComponent(url.pathname) === value;
const lease = "d".repeat(48);
async function installMedia(page: Page, rows: ReturnType<typeof tracks>) {
    const audio = createSyntheticWav(45);
    await page.route(path("/api/music-sources/resolve"), (route) => {
        const input = route.request().postDataJSON();
        expect(route.request().headers().authorization).toBe(
            "Bearer core-regression-token",
        );
        expect(
            rows.some(
                (row) =>
                    row.source === input.provider &&
                    row.musicSourceRecording.id === input.providerTrackId,
            ),
        ).toBe(true);
        expect(input.artists).toEqual(["First", "Guest"]);
        return route.fulfill({
            json: {
                playback: {
                    provider: input.provider,
                    leaseId: lease,
                    streamPath: `/api/music-sources/leases/${lease}/stream`,
                },
            },
        });
    });
    await page.route(
        path(`/api/music-sources/leases/${lease}/stream`),
        (route) => fulfillAudioRange(route, audio),
    );
    for (const row of rows) {
        await page.route(
            path(
                `/api/music-sources/recordings/${row.source}/${row.musicSourceRecording.id}/stream`,
            ),
            (route) => fulfillAudioRange(route, audio),
        );
        await page.route(
            path(`/api/library/remote-tracks/${row.id}/preference`),
            (route) =>
                route.fulfill({
                    json: {
                        trackId: row.id,
                        signal: null,
                        isLiked: false,
                        isDisliked: false,
                    },
                }),
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
    }
}
const queue = (page: Page) =>
    page.evaluate(() =>
        JSON.parse(localStorage.getItem("soundspan_queue") ?? "[]"),
    );

for (const provider of ["vk", "yandex"] as const) {
    test(`${provider} personal Wave continues through the personal feed without replacing playing media`, async ({
        page,
    }) => {
        const rows = tracks(provider, 27);
        await installMedia(page, rows);
        const requests: URL[] = [];
        let originalCalls = 0,
            release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route(path("/api/personalized/radio"), (route) => {
            originalCalls++;
            return route.fulfill({ json: { tracks: [], nextCursor: 0 } });
        });
        await page.route(path("/api/personalized/home"), async (route) => {
            const url = new URL(route.request().url());
            if (url.searchParams.get("surface") !== "wave")
                return route.fallback();
            const continuation =
                url.searchParams.get("exclude")?.includes(rows[0].id) ?? false;
            if (continuation) {
                requests.push(url);
                await held;
            }
            return route.fulfill({
                json: {
                    generationId: continuation
                        ? "personal-continued"
                        : "personal-initial",
                    shelves: {
                        listenAgain: [],
                        quickPicks: [],
                        discovery: continuation
                            ? rows.slice(2)
                            : rows.slice(0, 2),
                    },
                    seedCount: 1,
                    degraded: false,
                    degradedSources: [],
                    reason: null,
                    nextCursor: continuation ? 2 : 1,
                },
            });
        });
        try {
            await login(page);
            await page.goto("/vibe");
            await page.getByTestId("wave-main-toggle").click();
            await expectPlaying(page, lease);
            await page
                .getByRole("button", { name: "Открыть плеер", exact: true })
                .click();
            await page
                .getByRole("button", { name: "Следующий трек", exact: true })
                .last()
                .click();
            const currentMedia = `/recordings/${provider}/${rows[1].musicSourceRecording.id}/stream`;
            await expectPlaying(page, currentMedia);
            await expect.poll(() => requests.length).toBe(1);
            await expect
                .poll(async () =>
                    (await queue(page)).map((row: { id: string }) => row.id),
                )
                .toEqual(rows.slice(0, 2).map((row) => row.id));
            const before = (await readAudio(page, currentMedia))!;
            const mediaCount = await page.evaluate(
                () =>
                    (window as Window & { __coreAudio?: HTMLAudioElement[] })
                        .__coreAudio!.length,
            );
            release();
            await expect.poll(async () => (await queue(page)).length).toBe(27);
            await expectPlaying(page, currentMedia, before.time);
            expect((await readAudio(page, currentMedia))!.src).toBe(before.src);
            expect(
                await page.evaluate(
                    () =>
                        (
                            window as Window & {
                                __coreAudio?: HTMLAudioElement[];
                            }
                        ).__coreAudio!.length,
                ),
            ).toBe(mediaCount);
            const saved = await queue(page);
            expect(saved.map((row: { id: string }) => row.id)).toEqual(
                rows.map((row) => row.id),
            );
            expect(
                saved.every(
                    (row: {
                        radioOrigin?: unknown;
                        recommendationQueueMode?: string;
                    }) =>
                        row.radioOrigin === undefined &&
                        row.recommendationQueueMode !== "finite",
                ),
            ).toBe(true);
            expect(
                saved
                    .slice(2)
                    .every(
                        (row: { recommendationGenerationId: string }) =>
                            row.recommendationGenerationId ===
                            "personal-continued",
                    ),
            ).toBe(true);
            expect(requests[0].searchParams.get("exclude")).toBe(
                rows
                    .slice(0, 2)
                    .map((row) => row.id)
                    .join(","),
            );
            expect(requests[0].searchParams.get("surface")).toBe("wave");
            expect(requests[0].searchParams.get("mode")).toBe("for-you");
            expect(originalCalls).toBe(0);
        } finally {
            release();
        }
    });
}

test("native daily mix and Discover Weekly retain complete finite queues and selected occurrence", async ({
    page,
}) => {
    const rows = tracks("vk", 20).concat(tracks("yandex", 20));
    await installMedia(page, rows);
    await page.route(path("/api/discover/config"), (route) =>
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
    await page.route(path("/api/discover/batch-status"), (route) =>
        route.fulfill({ json: { active: false, status: null } }),
    );
    await page.route(path("/api/personalized/daily-mixes"), (route) =>
        route.fulfill({
            json: {
                mixes: [
                    {
                        key: "native-daily",
                        title: "Личный микс",
                        description: "",
                        generationId: "daily-native",
                        tracks: rows.slice(0, 20),
                    },
                ],
            },
        }),
    );
    await page.route(path("/api/system/features"), (route) =>
        route.fulfill({
            json: {
                discovery: true,
                musicCNN: false,
                vibeEmbeddings: false,
                audioAnalysis: true,
                autoPlaylists: false,
                federation: false,
            },
        }),
    );
    await page.route(path("/api/discover/current"), (route) =>
        route.fulfill({
            json: {
                kind: "online-weekly",
                generationId: "weekly-native",
                weekStart: "2026-10-05",
                weekEnd: "2026-10-12",
                tracks: rows.slice(20).map((row) => ({
                    ...row,
                    artist: row.artist.name,
                    album: "",
                    albumId: "",
                    coverUrl: null,
                    sourceType: row.source,
                    recommendationGenerationId: "weekly-native",
                    available: true,
                    similarity: 0,
                    tier: "explore",
                    isLiked: false,
                    likedAt: null,
                })),
                unavailable: [],
                totalCount: 20,
                unavailableCount: 0,
            },
        }),
    );
    await login(page);
    await page
        .locator('[data-home-made-card="native-daily"]')
        .getByRole("button", {
            name: "Воспроизвести: Личный микс",
            exact: true,
        })
        .click();
    await expectPlaying(page, lease);
    await expect
        .poll(async () =>
            (await queue(page)).map((row: { id: string }) => row.id),
        )
        .toEqual(rows.slice(0, 20).map((row) => row.id));
    expect(
        (await queue(page)).every(
            (row: {
                recommendationQueueMode: string;
                recommendationGenerationId: string;
            }) =>
                row.recommendationQueueMode === "finite" &&
                row.recommendationGenerationId === "daily-native",
        ),
    ).toBe(true);
    await page.goto("/discover");
    await expect(
        page.getByText("Яндекс Музыка", { exact: true }).first(),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Воспроизвести всё", exact: true })
        .click();
    await expect
        .poll(async () =>
            (await queue(page)).map((row: { id: string }) => row.id),
        )
        .toEqual(rows.slice(20).map((row) => row.id));
    expect(
        (await queue(page)).every(
            (row: {
                recommendationQueueMode: string;
                recommendationGenerationId: string;
            }) =>
                row.recommendationQueueMode === "finite" &&
                row.recommendationGenerationId === "weekly-native",
        ),
    ).toBe(true);
    await page
        .getByRole("button", { name: "Открыть плеер", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Следующий трек", exact: true })
        .last()
        .click();
    await expectPlaying(
        page,
        `/recordings/yandex/${rows[21].musicSourceRecording.id}/stream`,
    );
    expect(
        await page.evaluate(
            () =>
                JSON.parse(
                    localStorage.getItem("soundspan_current_track") ?? "null",
                ).id,
        ),
    ).toBe(rows[21].id);
});
