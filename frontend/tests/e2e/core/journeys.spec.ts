import { expect, type Page } from "@playwright/test";
import { test, TRACKS, login, readAudio, expectPlaying } from "./fixture";

async function openTastes(page: Page) {
    await page.goto("/settings");
    await page
        .getByRole("button", { name: "Уточнить предпочтения", exact: true })
        .click();
    return page.getByTestId("taste-profile-dialog");
}

test("first-run tastes can be skipped and do not reopen after reload", async ({
    page,
    app,
}) => {
    app.taste = {
        profile: null,
        completedAt: null,
        skippedAt: null,
        needsOnboarding: true,
    };
    await login(page);
    const dialog = page.getByTestId("taste-profile-dialog");
    await dialog
        .getByRole("button", { name: "Пропустить настройку", exact: true })
        .click();
    await expect(dialog).toHaveCount(0);
    expect(app.tasteWrites).toEqual([{ skip: true }]);
    expect(app.taste.profile).toBeNull();
    await page.reload();
    await expect(
        page.locator('[data-home-layout="personal-dashboard"]'),
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
});

test("login rejects wrong credentials, survives reload and logout protects routes", async ({
    page,
    app,
}) => {
    await page.goto("/library");
    await expect(page).toHaveURL(/\/login/);
    await page.locator("#username").fill("core-user");
    await page.locator("#password").fill("wrong-fixture-password");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(app.authenticated).toBe(false);
    await login(page);
    await expect(
        page.locator('[data-home-layout="personal-dashboard"]'),
    ).toBeVisible();
    await page.reload();
    await expect(
        page.locator('[data-home-layout="personal-dashboard"]'),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Открыть меню", exact: true })
        .click();
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(app.authenticated).toBe(false);
    await page.goto("/library");
    await expect(page).toHaveURL(/\/login/);
});

test("taste selections are saved and selected again after reload", async ({
    page,
    app,
}) => {
    await login(page);
    const dialog = await openTastes(page);
    for (const artist of app.artists.slice(0, 6)) {
        await dialog.getByRole("button", { name: artist, exact: true }).click();
    }
    await dialog
        .getByRole("button", { name: "Сохранить вкусы", exact: true })
        .click();
    await expect(dialog).toHaveCount(0);
    expect(app.tasteWrites).toEqual([
        { genres: [], artists: app.artists.slice(0, 6) },
    ]);
    await page.reload();
    const reopened = await openTastes(page);
    for (const artist of app.artists.slice(0, 6)) {
        await expect(
            reopened.getByRole("button", { name: artist, exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
    }
});

test("failed taste save keeps the selection and retry succeeds", async ({
    page,
    app,
}) => {
    await login(page);
    app.failTasteSaves = 1;
    const dialog = await openTastes(page);
    const artist = dialog.getByRole("button", {
        name: app.artists[0],
        exact: true,
    });
    await artist.click();
    await dialog
        .getByRole("button", { name: "Сохранить вкусы", exact: true })
        .click();
    await expect(dialog.getByRole("alert")).toContainText(
        "Не удалось сохранить",
    );
    await expect(artist).toHaveAttribute("aria-pressed", "true");
    expect(app.taste.profile).toBeNull();
    await dialog
        .getByRole("button", { name: "Сохранить вкусы", exact: true })
        .click();
    await expect(dialog).toHaveCount(0);
    expect(app.tasteWrites).toHaveLength(2);
    expect(app.taste.profile?.artists).toEqual([app.artists[0]]);
});

test("Wave tuning persists and plays the requested feed", async ({
    page,
    app,
}) => {
    await login(page);
    await page.goto("/vibe");
    await page.getByRole("button", { name: "Настроить", exact: true }).click();
    const sheet = page.getByTestId("wave-tune-sheet");
    await sheet
        .getByRole("radio", { name: "Больше нового", exact: true })
        .click();
    await sheet.getByRole("radio", { name: "Спокойно", exact: true }).click();
    await sheet
        .getByRole("button", {
            name: /^(?:Сохранить настройку|Обновить волну): Больше нового, Спокойно$/,
        })
        .click();
    await expect(page.getByTestId("wave-current-tuning")).toContainText(
        "Спокойно",
    );
    await page.getByTestId("wave-main-toggle").click();
    await expectPlaying(page, TRACKS[10].id);
    expect(
        app.requests.some(
            (request) =>
                request.path === "/api/personalized/home" &&
                request.search.includes("mode=new") &&
                request.search.includes("mood=calm") &&
                request.search.includes("surface=wave"),
        ),
    ).toBe(true);
    await page.goto("/library");
    await page.goto("/vibe");
    await expect(page.getByTestId("wave-current-tuning")).toContainText(
        "Открытия",
    );
    await expect(page.getByTestId("wave-current-tuning")).toContainText(
        "Спокойно",
    );
});

test("daily mixes start distinct complete queues and Next selects the second track", async ({
    page,
}) => {
    await login(page);
    const first = page.locator('[data-home-made-card="core-mix-a"]');
    const second = page.locator('[data-home-made-card="core-mix-b"]');
    await first
        .getByRole("button", {
            name: "Воспроизвести: Тестовый микс A",
            exact: true,
        })
        .click();
    await expectPlaying(page, TRACKS[0].id);
    await expect
        .poll(() =>
            page.evaluate(() =>
                JSON.parse(localStorage.getItem("soundspan_queue") ?? "[]").map(
                    (track: { id: string }) => track.id,
                ),
            ),
        )
        .toEqual(TRACKS.slice(0, 20).map((track) => track.id));
    await second
        .getByRole("button", {
            name: "Воспроизвести: Тестовый микс B",
            exact: true,
        })
        .click();
    await expectPlaying(page, TRACKS[20].id);
    await expect
        .poll(() =>
            page.evaluate(() =>
                JSON.parse(localStorage.getItem("soundspan_queue") ?? "[]").map(
                    (track: { id: string }) => track.id,
                ),
            ),
        )
        .toEqual(TRACKS.slice(20, 40).map((track) => track.id));
    await page
        .getByRole("button", { name: "Открыть плеер", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Следующий трек", exact: true })
        .last()
        .click();
    await expectPlaying(page, TRACKS[21].id);
});

test("real media pauses, resumes and switches track identity", async ({
    page,
}) => {
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
        .getByRole("button", { name: "Пауза", exact: true })
        .last()
        .click();
    await expect
        .poll(async () => (await readAudio(page, TRACKS[0].id))?.paused)
        .toBe(true);
    const stopped = (await readAudio(page, TRACKS[0].id))!.time;
    await page.waitForTimeout(400);
    expect((await readAudio(page, TRACKS[0].id))!.time).toBeLessThan(
        stopped + 0.1,
    );
    await page
        .getByRole("button", { name: "Воспроизвести", exact: true })
        .last()
        .click();
    await expectPlaying(page, TRACKS[0].id, stopped);
    await page
        .getByRole("button", { name: "Следующий трек", exact: true })
        .last()
        .click();
    await expectPlaying(page, TRACKS[1].id);
    await page
        .getByRole("button", { name: "Предыдущий трек", exact: true })
        .last()
        .click();
    await expectPlaying(page, TRACKS[0].id);
});

test("a UI download is playable from a device file after reload with network disabled", async ({
    page,
    app,
}) => {
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
        .getByRole("button", { name: "Действия с треком", exact: true })
        .last()
        .click();
    await page
        .getByRole("menuitem", { name: "Загрузить на устройство", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Свернуть плеер", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Загруженное", exact: true })
        .click();
    await expect(page.getByLabel("Сводка загрузок")).toContainText("1 трек");
    await page.reload();
    await page
        .getByRole("button", { name: "Загруженное", exact: true })
        .click();
    await expect(page.getByLabel("Сводка загрузок")).toContainText("1 трек");
    await app.setOffline();
    await page
        .getByRole("dialog", { name: "Загруженное", exact: true })
        .getByRole("button", {
            name: `Воспроизвести: ${TRACKS[0].title}`,
            exact: true,
        })
        .click();
    await expectPlaying(page, "blob:");
    expect(
        await page.evaluate(
            () =>
                JSON.parse(
                    localStorage.getItem("soundspan_current_track") ?? "null",
                )?.id,
        ),
    ).toBe(TRACKS[0].id);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    expect(app.offlineStreamRequests).toBe(0);
});
