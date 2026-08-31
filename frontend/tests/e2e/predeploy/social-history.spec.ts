import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

test.describe("Social and History", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("activity panel opens for a non-admin user", async ({ page }) => {
        await page.goto("/");

        const toggle = page
            .getByRole("button", {
                name: /открыть или закрыть панель активности/i,
            })
            .first();
        await expect(toggle).toBeVisible({ timeout: 5000 });
        await toggle.click();

        const notificationsTab = page
            .getByRole("button", { name: /^уведомления$/i })
            .first();
        await expect(notificationsTab).toBeVisible({ timeout: 5000 });
        await expect(page.getByText("Активность").first()).toBeVisible({
            timeout: 5000,
        });
        await expect(notificationsTab).toHaveClass(/border-b-2/, {
            timeout: 5000,
        });
        await page
            .getByRole("button", {
                name: "Закрыть панель активности",
                exact: true,
            })
            .click();
        await expect(page.getByText("Активность").first()).toBeHidden({
            timeout: 5000,
        });
    });

    test("my history page loads and shows queue-style actions", async ({
        page,
    }) => {
        await page.goto("/my-history");

        await expect(
            page.getByRole("heading", { name: /история прослушиваний/i }),
        ).toBeVisible({ timeout: 10000 });

        const emptyState = page.getByText("История пока пуста");
        const trackActionsButton = page
            .getByRole("button", { name: "Действия с треком" })
            .first();

        const resolvedState = await Promise.race([
            emptyState
                .waitFor({ state: "visible", timeout: 10000 })
                .then(() => "empty" as const),
            trackActionsButton
                .waitFor({ state: "visible", timeout: 10000 })
                .then(() => "actions" as const),
        ]);

        if (resolvedState === "empty") {
            await expect(emptyState).toBeVisible();
            return;
        }

        await expect(trackActionsButton).toBeVisible({ timeout: 5000 });
        await trackActionsButton.click();
        await expect(
            page.getByRole("menuitem", { name: "Добавить в очередь" }).first(),
        ).toBeVisible({ timeout: 5000 });
        await expect(
            page.getByRole("menuitem", { name: "Добавить в плейлист" }).first(),
        ).toBeVisible({ timeout: 5000 });
    });

    test("settings social controls are visible", async ({ page }) => {
        await page.goto("/settings");

        await expect(
            page.locator("text=Показывать, что я в сети").first(),
        ).toBeVisible({ timeout: 10000 });
        await expect(
            page.locator("text=Показывать, что я слушаю").first(),
        ).toBeVisible({ timeout: 10000 });
    });

    test("my history is accessed from settings, not sidebar navigation", async ({
        page,
    }) => {
        await page.goto("/");

        const mainNav = page.getByRole("navigation", {
            name: /основная навигация/i,
        });
        await expect(
            mainNav.getByRole("link", { name: /история/i }),
        ).toHaveCount(0);

        await page.goto("/settings");
        await expect(
            page.getByRole("link", { name: /открыть мою историю/i }),
        ).toBeVisible({ timeout: 10000 });
    });

    test("non-admin users do not see download tabs in activity panel", async ({
        page,
    }) => {
        await page.goto("/");

        const toggle = page
            .getByRole("button", {
                name: /открыть или закрыть панель активности/i,
            })
            .first();
        await expect(toggle).toBeVisible({ timeout: 5000 });
        await toggle.click();

        await expect(
            page.getByRole("button", { name: /^уведомления$/i }),
        ).toBeVisible({ timeout: 5000 });
        await expect(
            page.getByRole("button", { name: /^сейчас онлайн$/i }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("button", { name: /^активные$/i }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("button", { name: /^история$/i }),
        ).toHaveCount(0);
    });
});
