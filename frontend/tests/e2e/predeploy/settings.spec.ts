import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

test.describe("Settings", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("settings page loads with account section", async ({ page }) => {
        await page.goto("/settings");

        await expect(
            page.getByRole("heading", { name: "Настройки" }),
        ).toBeVisible();

        // Should have Account section (use first() since multiple elements match)
        await expect(
            page.getByText("Аккаунт", { exact: true }).first(),
        ).toBeVisible({
            timeout: 5000,
        });
    });

    test("settings page shows playback section", async ({ page }) => {
        await page.goto("/settings");

        // Should have Playback section (use first() since multiple elements match)
        await expect(
            page.getByText("Воспроизведение", { exact: true }).first(),
        ).toBeVisible({
            timeout: 5000,
        });
    });

    test("settings page links to my history page", async ({ page }) => {
        await page.goto("/settings");

        const openHistoryLink = page.getByRole("link", {
            name: "Открыть мою историю",
        });
        await expect(openHistoryLink).toBeVisible({ timeout: 5000 });
        await openHistoryLink.click();

        await expect(page).toHaveURL(/\/my-history/);
        await expect(
            page.getByRole("heading", { name: "Моя история" }),
        ).toBeVisible({ timeout: 10000 });
    });
});
