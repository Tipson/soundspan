import { test, expect } from "@playwright/test";

const username = process.env.SOUNDSPAN_TEST_USERNAME || "predeploy";
const password = process.env.SOUNDSPAN_TEST_PASSWORD || "predeploy-password";

test("core smoke: login → play album → play/pause/next/prev", async ({
    page,
}) => {
    // Login
    await page.goto("/login");
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Войти", exact: true }).click();

    // Login redirects to / (assuming onboarding was already completed by the API smoke test)
    await page.waitForURL(/\/($|\?)/);

    // Open the album collection and choose the first release.
    await page.goto("/library?tab=albums");

    const firstAlbum = page.locator('a[href^="/album/"]').first();
    const albumCount = await firstAlbum.count();
    expect(albumCount).toBeGreaterThan(0);
    await firstAlbum.click();

    // Start playback
    await page.getByLabel("Воспроизвести всё").click();

    // Mini player should reflect playing state
    const playPause = page
        .locator('button[title="Пауза"], button[title="Воспроизвести"]')
        .first();
    await expect(playPause).toHaveAttribute("title", "Пауза");

    // Toggle pause/play
    await playPause.click();
    await expect(playPause).toHaveAttribute("title", "Воспроизвести");
    await playPause.click();
    await expect(playPause).toHaveAttribute("title", "Пауза");

    // Next/Previous should be available for tracks (library content)
    const nextBtn = page.locator('button[title="Следующий трек"]');
    const prevBtn = page.locator('button[title="Предыдущий трек"]');
    await expect(nextBtn).toBeVisible();
    await expect(prevBtn).toBeVisible();

    await nextBtn.click();
    await prevBtn.click();
});
