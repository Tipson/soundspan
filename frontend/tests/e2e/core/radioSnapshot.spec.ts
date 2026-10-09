import { expect } from "@playwright/test";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import { test, TRACKS, login, readAudio, expectPlaying } from "./fixture";

test("a same-song station poll preserves paused native media and resumes from its position", async ({
    page,
    app,
}) => {
    // Only JavaScript timer cadence is accelerated. Native audio is decoded and
    // paused/resumed through the real player UI; its clock is never substituted.
    await page.clock.install();
    const matches = (path: string) => (url: URL) =>
        url.origin === CORE_ORIGIN && url.pathname === path;
    await page.route(matches("/api/library/radio"), (route) =>
        route.fulfill({ json: { tracks: TRACKS.slice(1, 20) } }),
    );
    let snapshot: Record<string, unknown> | null = null;
    let polls = 0;
    await page.route(matches("/api/playback-state"), (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        if (snapshot) polls += 1;
        return route.fulfill({ json: snapshot });
    });
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
    const savedQueue = () =>
        page.evaluate(() =>
            JSON.parse(localStorage.getItem("soundspan_queue") ?? "[]"),
        );
    await expect.poll(async () => (await savedQueue()).length).toBe(20);
    await page
        .getByRole("button", { name: "Пауза", exact: true })
        .last()
        .click();
    await expect
        .poll(async () => (await readAudio(page, TRACKS[0].id))?.paused)
        .toBe(true);
    const before = (await readAudio(page, TRACKS[0].id))!;
    const beforeQueue = await savedQueue();
    const beforeCount = await page.evaluate(
        () =>
            (window as Window & { __coreAudio?: HTMLAudioElement[] })
                .__coreAudio!.length,
    );
    const playbackWrites = () =>
        app.requests.filter(
            (r) =>
                r.path === "/api/playback-state" &&
                (r.method === "PUT" || r.method === "POST"),
        ).length;
    // Let the explicit pause's ordinary save finish before measuring metadata writes.
    await page.clock.runFor(500);
    const writes = playbackWrites();
    const newOrigin = {
        kind: "artist",
        source: "discovery",
        name: "New synthetic station",
    };
    snapshot = {
        playbackType: "track",
        trackId: TRACKS[0].id,
        currentIndex: 0,
        currentTime: 999,
        isPlaying: true,
        isShuffle: true,
        updatedAt: new Date(
            (await page.evaluate(() => Date.now())) + 100000,
        ).toISOString(),
        queue: beforeQueue.map((row: Record<string, unknown>) => ({
            ...row,
            title: "Untrusted replacement title",
            filePath: "other.wav",
            recommendationGenerationId: "do-not-adopt",
            radioOrigin: newOrigin,
        })),
    };
    await page.clock.runFor(40000);
    await expect.poll(() => polls).toBeGreaterThan(0);
    await expect
        .poll(async () => (await savedQueue())[0].radioOrigin)
        .toEqual(newOrigin);
    const after = (await readAudio(page, TRACKS[0].id))!;
    expect(after.paused).toBe(true);
    expect(after.src).toBe(before.src);
    expect(after.time).toBeCloseTo(before.time, 2);
    expect(
        await page.evaluate(
            () =>
                (window as Window & { __coreAudio?: HTMLAudioElement[] })
                    .__coreAudio!.length,
        ),
    ).toBe(beforeCount);
    expect(
        (await savedQueue()).map((row: Record<string, unknown>) => row.title),
    ).toEqual(beforeQueue.map((row: Record<string, unknown>) => row.title));
    expect(
        await page.evaluate(() =>
            localStorage.getItem("soundspan_current_index"),
        ),
    ).toBe("0");
    expect(
        await page.evaluate(() => localStorage.getItem("soundspan_is_shuffle")),
    ).toBe("false");
    expect(playbackWrites()).toBe(writes);
    await page
        .getByRole("button", { name: "Воспроизвести", exact: true })
        .last()
        .click();
    await expectPlaying(page, TRACKS[0].id, before.time);
    expect((await readAudio(page, TRACKS[0].id))!.src).toBe(before.src);
});
