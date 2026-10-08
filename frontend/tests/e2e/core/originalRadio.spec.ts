import { expect, type Page } from "@playwright/test";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import { test, TRACKS, login, readAudio, expectPlaying } from "./fixture";

const origin = { kind: "track", source: "library", id: TRACKS[0].id };
const localPath = (path: string) => (url: URL) =>
    url.origin === CORE_ORIGIN && url.pathname === path;

async function queue(page: Page) {
    return page.evaluate(() =>
        JSON.parse(localStorage.getItem("soundspan_queue") ?? "[]"),
    );
}

async function openOriginalRadio(page: Page) {
    await login(page);
    await page
        .locator('[data-home-made-card="core-mix-a"]')
        .getByRole("button")
        .click();
    await expectPlaying(page, TRACKS[0].id);
    await page
        .getByRole("button", { name: "Открыть плеер", exact: true })
        .click();
    await page
        .getByRole("button", {
            name: "Включить радио исполнителя",
            exact: true,
        })
        .click();
    await expect
        .poll(async () =>
            (await queue(page)).map((track: { id: string }) => track.id),
        )
        .toEqual([TRACKS[0].id, TRACKS[1].id]);
    await page
        .getByRole("button", { name: "Следующий трек", exact: true })
        .last()
        .click();
    await expectPlaying(page, TRACKS[1].id);
}

// The original-station API is synthetic and local. The application, native
// HTMLAudioElement, media decoding and advancing playback clock are real.
test("original radio appends ordered tracks without reloading the current media", async ({
    page,
}) => {
    await page.route(localPath("/api/library/radio"), (route) =>
        route.fulfill({ json: { tracks: [TRACKS[1]] } }),
    );
    const requests: URL[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(localPath("/api/personalized/radio"), async (route) => {
        expect(route.request().headers().authorization).toBe(
            "Bearer core-regression-token",
        );
        requests.push(new URL(route.request().url()));
        await gate;
        await route.fulfill({
            json: {
                tracks: TRACKS.slice(20, 35),
                radioOrigin: origin,
                generationId: "core-original-radio-generation",
                nextCursor: 1,
                degraded: false,
                degradedSources: [],
            },
        });
    });
    try {
        await openOriginalRadio(page);
        await expect.poll(() => requests.length).toBe(1);
        const before = (await readAudio(page, TRACKS[1].id))!;
        const mediaCount = await page.evaluate(
            () =>
                (window as Window & { __coreAudio?: HTMLAudioElement[] })
                    .__coreAudio!.length,
        );
        release();
        await expect.poll(async () => (await queue(page)).length).toBe(17);
        await expectPlaying(page, TRACKS[1].id, before.time);
        const after = (await readAudio(page, TRACKS[1].id))!;
        expect(after.src).toBe(before.src);
        expect(after.time).toBeGreaterThan(before.time);
        expect(
            await page.evaluate(
                () =>
                    (window as Window & { __coreAudio?: HTMLAudioElement[] })
                        .__coreAudio!.length,
            ),
        ).toBe(mediaCount);
        const saved = await queue(page);
        expect(saved.map((track: { id: string }) => track.id)).toEqual([
            TRACKS[0].id,
            TRACKS[1].id,
            ...TRACKS.slice(20, 35).map((track) => track.id),
        ]);
        expect(
            saved.every(
                (track: { radioOrigin?: unknown }) =>
                    JSON.stringify(track.radioOrigin) ===
                    JSON.stringify(origin),
            ),
        ).toBe(true);
        expect(
            saved
                .slice(2)
                .every(
                    (track: {
                        recommendationGenerationId?: string;
                        recommendationSessionId?: string;
                    }) =>
                        track.recommendationGenerationId ===
                            "core-original-radio-generation" &&
                        Boolean(track.recommendationSessionId),
                ),
        ).toBe(true);
        const query = requests[0].searchParams;
        expect(query.get("type")).toBe("vibe");
        expect(query.get("value")).toBe(TRACKS[0].id);
        expect(query.get("cursor")).toBe("0");
        expect(query.get("exclude")).toBe(
            `library:${TRACKS[0].id},library:${TRACKS[1].id}`,
        );
        expect(
            query.has("mode") || query.has("mood") || query.has("userId"),
        ).toBe(false);
    } finally {
        release();
    }
});

test("changing the station on the same playing track rejects an old radio response", async ({
    page,
}) => {
    await page.route(localPath("/api/library/radio"), (route) => {
        const value = new URL(route.request().url()).searchParams.get("value");
        return route.fulfill({
            json: { tracks: [value === TRACKS[0].id ? TRACKS[1] : TRACKS[2]] },
        });
    });
    let started = 0;
    let delivered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(localPath("/api/personalized/radio"), async (route) => {
        started += 1;
        await gate;
        await route.fulfill({
            json: {
                tracks: TRACKS.slice(20, 35),
                radioOrigin: origin,
                generationId: "core-superseded-radio-generation",
                nextCursor: 1,
                degraded: false,
                degradedSources: [],
            },
        });
        delivered += 1;
    });
    try {
        await openOriginalRadio(page);
        await expect.poll(() => started).toBe(1);
        const before = (await readAudio(page, TRACKS[1].id))!;
        await page
            .getByRole("button", {
                name: "Включить радио исполнителя",
                exact: true,
            })
            .click();
        await expect
            .poll(async () =>
                (await queue(page)).map((track: { id: string }) => track.id),
            )
            .toEqual([TRACKS[1].id, TRACKS[2].id]);
        release();
        await expect.poll(() => delivered).toBe(1);
        await expectPlaying(page, TRACKS[1].id, before.time);
        const saved = await queue(page);
        expect(saved.map((track: { id: string }) => track.id)).toEqual([
            TRACKS[1].id,
            TRACKS[2].id,
        ]);
        expect(
            saved.every(
                (track: { radioOrigin?: { id: string } }) =>
                    track.radioOrigin?.id === TRACKS[1].id,
            ),
        ).toBe(true);
        expect((await readAudio(page, TRACKS[1].id))!.src).toBe(before.src);
        expect(started).toBe(1);
    } finally {
        release();
    }
});
