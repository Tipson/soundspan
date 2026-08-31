import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

const albumSearchQuery = process.env.SOUNDSPAN_E2E_ALBUM_QUERY || "Linkin Park";
const candidateViewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
] as const;

test.describe("Library", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("home page loads with library stats", async ({ page }) => {
        await page.goto("/");
        // Should show some indication of library content
        await expect(page.locator("body")).toContainText(
            /artist|album|track|library/i,
        );
    });

    test("albums tab shows album grid", async ({ page }) => {
        await page.goto("/library?tab=albums");
        await expect(
            page.getByRole("heading", { name: /library/i }),
        ).toBeVisible();

        // Should have at least one album link
        const albumLinks = page.locator('a[href^="/album/"]');
        await expect(albumLinks.first()).toBeVisible({ timeout: 10000 });
    });

    test("artists tab shows artist list", async ({ page }) => {
        await page.goto("/library?tab=artists");
        await expect(
            page.getByRole("heading", { name: /library/i }),
        ).toBeVisible();

        // Should have at least one artist link
        const artistLinks = page.locator('a[href^="/artist/"]');
        await expect(artistLinks.first()).toBeVisible({ timeout: 10000 });
    });

    test("tracks tab shows track list", async ({ page }) => {
        await page.goto("/library?tab=tracks");
        await expect(
            page.getByRole("heading", { name: /library/i }),
        ).toBeVisible();

        // Should have at least one track in the list
        const trackRows = page.locator('[data-track-id], [class*="track"]');
        await expect(trackRows.first()).toBeVisible({ timeout: 10000 });
    });

    test("search page accessible", async ({ page }) => {
        await page.goto("/search");

        // Search page should load
        await expect(page.locator("body")).toBeVisible();
        await expect(page).toHaveURL(/search/);
    });

    for (const viewport of candidateViewports) {
        test(`[candidate] Search → Album opens a canonical release on ${viewport.name}`, async ({
            page,
        }) => {
            await page.setViewportSize(viewport);
            await page.goto(
                `/search?q=${encodeURIComponent(albumSearchQuery)}`,
            );

            const albumLink = page
                .locator(
                    '[data-tv-section="search-results-albums"] a[href^="/album/"]',
                )
                .first();
            await expect(albumLink).toBeVisible({ timeout: 30000 });

            const albumHref = await albumLink.getAttribute("href");
            const albumTitle = (
                await albumLink.locator("h3").innerText()
            ).trim();
            expect(albumHref).toMatch(/^\/album\/[^/?#]+$/);
            expect(albumTitle.length).toBeGreaterThan(0);

            await albumLink.click();
            await page.waitForURL((url) => url.pathname === albumHref, {
                timeout: 30000,
            });

            await expect(
                page
                    .getByRole("heading", {
                        name: albumTitle,
                        exact: true,
                    })
                    .first(),
            ).toBeVisible({ timeout: 30000 });
            await expect(
                page.getByText(/Альбом не найден|Album not found/i),
            ).toHaveCount(0);
        });
    }
});
