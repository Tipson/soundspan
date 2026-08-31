import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

const NON_PERSONAL_STATION_PATTERN =
    /TOP\s*100\s*VIDEOS|TRENDING\s*20|GERMANY|Лучшие клипы|Хит-парад/i;

test.describe("Personalization candidate", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("[candidate] Vibe keeps tuning after navigating away and back", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/vibe?mode=for-you");
        await expect(page.getByTestId("wave-surface")).toBeVisible({
            timeout: 30000,
        });

        await page
            .getByRole("button", { name: "Настроить", exact: true })
            .click();
        const tuneSheet = page.getByTestId("wave-tune-sheet");
        await expect(tuneSheet).toBeVisible();
        await tuneSheet
            .getByRole("radio", { name: "Больше нового", exact: true })
            .click();
        await tuneSheet
            .getByRole("radio", { name: "Спокойное", exact: true })
            .click();
        await tuneSheet
            .getByRole("button", {
                name: /^(?:Сохранить настройку|Обновить волну): Больше нового, Спокойное$/,
            })
            .click();

        await expect
            .poll(() => new URL(page.url()).searchParams.get("mode"))
            .toBe("new");
        await expect
            .poll(() => new URL(page.url()).searchParams.get("mood"))
            .toBe("calm");
        const currentTuning = page.getByTestId("wave-current-tuning");
        await expect(currentTuning).toContainText("Открытия");
        await expect(currentTuning).toContainText("Спокойное");

        await page.goto("/");
        await expect(
            page.locator('[data-home-layout="personal-dashboard"]'),
        ).toBeVisible({
            timeout: 30000,
        });
        await page.goto("/vibe");
        await expect(page.getByTestId("wave-surface")).toBeVisible({
            timeout: 30000,
        });
        await expect(page.getByTestId("wave-current-tuning")).toContainText(
            "Открытия",
        );
        await expect(page.getByTestId("wave-current-tuning")).toContainText(
            "Спокойное",
        );

        await page
            .getByRole("button", { name: "Настроить", exact: true })
            .click();
        const reopenedSheet = page.getByTestId("wave-tune-sheet");
        await expect(
            reopenedSheet.getByRole("radio", {
                name: "Больше нового",
                exact: true,
            }),
        ).toHaveAttribute("aria-checked", "true");
        await expect(
            reopenedSheet.getByRole("radio", {
                name: "Спокойное",
                exact: true,
            }),
        ).toHaveAttribute("aria-checked", "true");
    });

    test("[candidate] Home keeps personalized stations clean and unique", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto("/");
        await expect(
            page.locator('[data-home-layout="personal-dashboard"]'),
        ).toBeVisible({
            timeout: 30000,
        });

        const stationRail = page.locator('[data-home-rail="stations"]');
        test.skip(
            (await stationRail.count()) === 0,
            "The QA profile has no taste signals, so personalized stations cannot be asserted.",
        );

        await expect(stationRail).toBeVisible({ timeout: 30000 });
        await expect(stationRail).not.toContainText(
            NON_PERSONAL_STATION_PATTERN,
        );

        const stationCards = stationRail.locator(
            '[data-home-card-shape="landscape"]',
        );
        const stationCount = await stationCards.count();
        expect(stationCount).toBeGreaterThan(0);
        await expect(
            stationRail.locator(
                '[data-home-card-shape]:not([data-home-card-shape="landscape"])',
            ),
        ).toHaveCount(0);

        const stationHrefs = await stationCards.evaluateAll((cards) =>
            cards.map((card) => card.getAttribute("href")),
        );
        expect(stationHrefs.every(Boolean)).toBe(true);
        expect(new Set(stationHrefs).size).toBe(stationHrefs.length);
    });
});
