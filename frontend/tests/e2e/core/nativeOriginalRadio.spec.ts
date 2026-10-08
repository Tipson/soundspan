import { expect } from "@playwright/test";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import { test, login, expectPlaying, readAudio } from "./fixture";
import {
    createSyntheticWav,
    fulfillAudioRange,
} from "../fixtures/syntheticAudio";

// Actual application and decoded media; only owned APIs and audio bytes are synthetic.
for (const provider of ["vk", "yandex"] as const) {
    test(`${provider} radio uses the original native seed and appends without replacing playing media`, async ({
        page,
    }) => {
        const rows = Array.from({ length: 27 }, (_, i) => {
            const id =
                provider === "vk"
                    ? `-001_${String(i + 1).padStart(3, "0")}`
                    : String(i + 1).padStart(4, "0");
            const recording = {
                provider,
                id,
                title: `Native ${i + 1}`,
                artists: ["First", "Guest"],
                duration: 45,
                contentVersion: "clean",
                preview: false,
            };
            return {
                id: `${provider}:${id}`,
                title: recording.title,
                duration: 45,
                trackNo: null,
                source: provider,
                streamSource: provider,
                artist: { id: null, name: recording.artists.join(", ") },
                album: { id: null, title: "", coverArt: null },
                provider: {
                    source: provider,
                    providerTrackId: id,
                    youtubeVideoId: null,
                    tidalTrackId: null,
                },
                musicSourceRecording: recording,
            };
        });
        const seed = rows[0],
            next = rows[1],
            origin = {
                kind: "track",
                source: provider,
                id: seed.musicSourceRecording.id,
            };
        const path = (value: string) => (url: URL) =>
            url.origin === CORE_ORIGIN &&
            decodeURIComponent(url.pathname) === value;
        await page.route(path("/api/library/liked"), (route) =>
            route.fulfill({
                json: {
                    playlist: { id: "my-liked", name: "Любимые треки" },
                    tracks: [seed],
                    total: 1,
                    pagination: {
                        limit: 100,
                        hasMore: false,
                        nextCursor: null,
                    },
                },
            }),
        );
        const audio = createSyntheticWav(45),
            lease = "c".repeat(48);
        await page.route(path("/api/music-sources/resolve"), (route) => {
            const input = route.request().postDataJSON();
            expect(input.provider).toBe(provider);
            expect(input.providerTrackId).toBe(seed.musicSourceRecording.id);
            expect(input.artists).toEqual(["First", "Guest"]);
            expect(route.request().headers().authorization).toBe(
                "Bearer core-regression-token",
            );
            return route.fulfill({
                json: {
                    playback: {
                        provider,
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
                    `/api/music-sources/recordings/${provider}/${row.musicSourceRecording.id}/stream`,
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
            // The pre-radio collection tail still probes the legacy similarity API.
            // It has no authority to create a native station or substitute a track.
            await page.route(path(`/api/vibe/similar/${row.id}`), (route) =>
                route.fulfill({ json: { tracks: [] } }),
            );
        }
        const requests: URL[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route(path("/api/personalized/radio"), async (route) => {
            expect(route.request().headers().authorization).toBe(
                "Bearer core-regression-token",
            );
            requests.push(new URL(route.request().url()));
            const first = requests.length === 1;
            if (!first) await gate;
            await route.fulfill({
                json: {
                    tracks: first ? [next] : rows.slice(2),
                    radioOrigin: origin,
                    generationId: first ? "native-initial" : "native-continued",
                    nextCursor: first ? 1 : 2,
                    degraded: false,
                    degradedSources: [],
                },
            });
        });
        const queue = () =>
            page.evaluate(() =>
                JSON.parse(localStorage.getItem("soundspan_queue") ?? "[]"),
            );
        try {
            await login(page);
            await page.goto("/playlist/my-liked");
            await page
                .getByRole("button", { name: "Воспроизвести всё", exact: true })
                .click();
            await expectPlaying(page, lease);
            await page
                .getByRole("button", { name: "Открыть плеер", exact: true })
                .click();
            const radio = page
                .locator(".overlay-player-stage")
                .getByRole("button", {
                    name: "Включить радио исполнителя",
                    exact: true,
                });
            await expect(radio).toBeVisible();
            await radio.click();
            await expect
                .poll(async () =>
                    (await queue()).map((t: { id: string }) => t.id),
                )
                .toEqual([seed.id, next.id]);
            await page
                .getByRole("button", { name: "Следующий трек", exact: true })
                .last()
                .click();
            const mediaPath = `/recordings/${provider}/${next.musicSourceRecording.id}/stream`;
            await expectPlaying(page, mediaPath);
            await expect.poll(() => requests.length).toBe(2);
            const before = (await readAudio(page, mediaPath))!;
            const mediaCount = await page.evaluate(
                () =>
                    (window as Window & { __coreAudio?: HTMLAudioElement[] })
                        .__coreAudio!.length,
            );
            release();
            await expect.poll(async () => (await queue()).length).toBe(27);
            await expectPlaying(page, mediaPath, before.time);
            expect((await readAudio(page, mediaPath))!.src).toBe(before.src);
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
            const saved = await queue();
            expect(saved.map((t: { id: string }) => t.id)).toEqual(
                rows.map((t) => t.id),
            );
            expect(
                saved.every(
                    (t: { radioOrigin: unknown }) =>
                        JSON.stringify(t.radioOrigin) ===
                        JSON.stringify(origin),
                ),
            ).toBe(true);
            for (const request of requests) {
                expect(request.searchParams.get("type")).toBe(provider);
                expect(request.searchParams.get("value")).toBe(
                    seed.musicSourceRecording.id,
                );
                expect(request.searchParams.has("userId")).toBe(false);
            }
            expect(requests[1].searchParams.get("exclude")).toBe(
                `${seed.id},${next.id}`,
            );
            expect(requests[1].searchParams.get("cursor")).toBe("0");
            expect(
                saved
                    .slice(2)
                    .every(
                        (t: { recommendationGenerationId: string }) =>
                            t.recommendationGenerationId === "native-continued",
                    ),
            ).toBe(true);
        } finally {
            release();
        }
    });
}
