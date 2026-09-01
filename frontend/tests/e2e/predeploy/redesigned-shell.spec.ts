import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

const desktopViewport = { width: 1487, height: 1058 };
const mobileViewport = { width: 390, height: 844 };

async function requiredBox(locator: Locator) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("Expected a visible layout box");
    return box;
}

async function pageOverflow(page: Page) {
    return page.evaluate(() => {
        const root = document.documentElement;
        const body = document.body;
        return {
            horizontal: Math.max(
                root.scrollWidth - root.clientWidth,
                body.scrollWidth - body.clientWidth,
            ),
            vertical: Math.max(
                root.scrollHeight - root.clientHeight,
                body.scrollHeight - body.clientHeight,
            ),
        };
    });
}

async function expectInsideBoundary(boundary: Locator, target: Locator) {
    const boundaryBox = await requiredBox(boundary);
    const targetBox = await requiredBox(target);
    const tolerance = 2;

    expect(targetBox.y).toBeGreaterThanOrEqual(boundaryBox.y - tolerance);
    expect(targetBox.y + targetBox.height).toBeLessThanOrEqual(
        boundaryBox.y + boundaryBox.height + tolerance,
    );
}

test.describe("Redesigned application shell", () => {
    test.describe("desktop", () => {
        test.use({ viewport: desktopViewport });

        test.beforeEach(async ({ page }) => {
            await loginAsTestUser(page);
        });

        test("Home preserves the sidebar, main-column topbar, and semantic dashboard regions", async ({
            page,
        }) => {
            const runtimeErrors: string[] = [];
            page.on("pageerror", (error) => runtimeErrors.push(error.message));
            page.on("console", (message) => {
                if (message.type() === "error") {
                    const location = message.location().url;
                    const isOptionalAvatarFallback =
                        message.text().includes("404") &&
                        location.includes("/api/social/profile-picture/");
                    const isDisabledOptionalHomeFeature =
                        (message.text().includes("feature disabled") ||
                            message.text().includes("404")) &&
                        ["/api/mixes", "/api/discover/current"].some(
                            (path) =>
                                location.includes(path) ||
                                message.text().includes(path),
                        );
                    if (
                        isOptionalAvatarFallback ||
                        isDisabledOptionalHomeFeature
                    ) {
                        return;
                    }
                    runtimeErrors.push(`${message.text()} @ ${location}`);
                }
            });
            await page.goto("/");

            const workspace = page.locator('[data-shell-workspace="desktop"]');
            const sidebar = workspace.locator('[data-shell-sidebar="desktop"]');
            const mainColumn = workspace.locator(
                '[data-shell-main-column="desktop"]',
            );
            const topbar = mainColumn.locator('[data-shell-topbar="desktop"]');
            const home = page.locator(
                '[data-home-layout="personal-dashboard"]',
            );

            await expect(workspace).toBeVisible({ timeout: 30_000 });
            await expect(sidebar).toBeVisible();
            await expect(topbar).toBeVisible();
            await expect(home).toBeVisible({ timeout: 30_000 });

            const sidebarBox = await requiredBox(sidebar);
            const mainColumnBox = await requiredBox(mainColumn);
            const topbarBox = await requiredBox(topbar);

            expect(sidebarBox.width).toBeGreaterThanOrEqual(240);
            expect(sidebarBox.width).toBeLessThanOrEqual(256);
            expect(
                Math.abs(sidebarBox.x + sidebarBox.width - mainColumnBox.x),
            ).toBeLessThanOrEqual(2);
            expect(Math.abs(topbarBox.x - mainColumnBox.x)).toBeLessThanOrEqual(
                2,
            );
            expect(Math.abs(topbarBox.y - mainColumnBox.y)).toBeLessThanOrEqual(
                2,
            );
            expect(topbarBox.width).toBeLessThanOrEqual(
                mainColumnBox.width + 2,
            );

            const mainContent = page.locator("#main-content");
            for (const region of ["wave", "listening-dashboard", "mixes"]) {
                await expect(
                    mainContent.locator(`[data-home-region="${region}"]`),
                ).toBeAttached();
            }
            await expect(
                home.locator('[data-home-wave-layout="editorial-wave"]'),
            ).toBeVisible();
            expect(runtimeErrors).toEqual([]);
        });

        test("desktop player keeps its expanded geometry after media starts", async ({
            page,
        }) => {
            await page.goto("/");
            const wavePlay = page
                .locator('[data-home-wave-layout="editorial-wave"]')
                .getByRole("button")
                .first();
            await expect(wavePlay).toBeVisible({ timeout: 30_000 });
            test.skip(
                !(await wavePlay.isEnabled()),
                "The QA account has no playable personalized feed.",
            );

            await wavePlay.click();
            const player = page.locator('[data-player-surface="desktop"]');
            await expect(player).toBeVisible();
            await expect(
                player.locator('[data-player-control="repeat"]'),
            ).toBeEnabled({ timeout: 20_000 });

            const playerBox = await requiredBox(player);
            expect(playerBox.height).toBeGreaterThanOrEqual(120);
            expect(playerBox.height).toBeLessThanOrEqual(136);
            await expect(
                player.locator('[data-player-region="identity"]'),
            ).toBeVisible();
            await expect(
                player.locator('[data-player-region="transport"]'),
            ).toBeVisible();
            await expect(
                player.locator('[data-player-level="timeline"]'),
            ).toBeVisible();
        });

        test("Vibe owns a locked app viewport without document overflow", async ({
            page,
        }) => {
            await page.goto("/vibe");
            const appBoundary = page.locator(
                '[data-app-scroll-container][data-shell-scroll-mode="locked"]',
            );
            const waveSurface = page.getByTestId("wave-surface");
            await expect(appBoundary).toBeVisible({ timeout: 30_000 });
            await expect(waveSurface).toBeVisible({ timeout: 30_000 });

            await expect
                .poll(async () => (await pageOverflow(page)).vertical)
                .toBeLessThanOrEqual(2);

            const boundaryMetrics = await appBoundary.evaluate((element) => {
                const style = getComputedStyle(element);
                return {
                    clientHeight: element.clientHeight,
                    scrollHeight: element.scrollHeight,
                    overflowY: style.overflowY,
                };
            });
            expect(boundaryMetrics.overflowY).toBe("hidden");
            expect(boundaryMetrics.scrollHeight).toBeLessThanOrEqual(
                boundaryMetrics.clientHeight + 2,
            );

            const boundaryBox = await requiredBox(appBoundary);
            const waveBox = await requiredBox(waveSurface);
            expect(waveBox.y).toBeGreaterThanOrEqual(boundaryBox.y - 2);
            expect(waveBox.y + waveBox.height).toBeLessThanOrEqual(
                boundaryBox.y + boundaryBox.height + 2,
            );
        });
    });

    test.describe("short desktop", () => {
        test.use({ viewport: { width: 1366, height: 768 } });

        test.beforeEach(async ({ page }) => {
            await loginAsTestUser(page);
            await page.goto("/vibe");
        });

        test("Vibe keeps tuning controls inside its locked boundary", async ({
            page,
        }) => {
            const boundary = page.locator(
                '[data-app-scroll-container][data-shell-scroll-mode="locked"]',
            );
            const waveSurface = page.getByTestId("wave-surface");
            const waveToggle = page.getByTestId("wave-main-toggle");
            const currentTuning = page.getByTestId("wave-current-tuning");
            const tuneButton = currentTuning.getByRole("button");

            await expect(boundary).toBeVisible({ timeout: 30_000 });
            await expect(waveSurface).toBeVisible({ timeout: 30_000 });
            await expect(waveToggle).toBeVisible();
            await expect(currentTuning).toBeVisible();
            await expect(tuneButton).toBeVisible();

            await expectInsideBoundary(boundary, waveSurface);
            await expectInsideBoundary(boundary, waveToggle);
            await expectInsideBoundary(boundary, currentTuning);
            await expectInsideBoundary(boundary, tuneButton);

            const boundaryMetrics = await boundary.evaluate((element) => ({
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
                overflowY: getComputedStyle(element).overflowY,
            }));
            expect(boundaryMetrics.overflowY).toBe("hidden");
            expect(boundaryMetrics.scrollHeight).toBeLessThanOrEqual(
                boundaryMetrics.clientHeight + 2,
            );
        });

        test("active Vibe keeps feedback and skip controls inside its locked boundary", async ({
            page,
        }) => {
            const boundary = page.locator(
                '[data-app-scroll-container][data-shell-scroll-mode="locked"]',
            );
            const waveToggle = page.getByTestId("wave-main-toggle");
            await expect(waveToggle).toBeVisible({ timeout: 30_000 });
            test.skip(
                !(await waveToggle.isEnabled()),
                "The QA account has no playable personalized feed.",
            );

            await waveToggle.click();
            const nowPlayingPanel = page.getByTestId("wave-now-playing-panel");
            const skipButton = page.getByTestId("wave-skip");
            await expect(nowPlayingPanel).toBeVisible({ timeout: 20_000 });
            await expect(skipButton).toBeVisible();

            await expectInsideBoundary(boundary, nowPlayingPanel);
            await expectInsideBoundary(boundary, skipButton);
        });
    });

    test.describe("mobile", () => {
        test.use({ viewport: mobileViewport });

        test.beforeEach(async ({ page }) => {
            await loginAsTestUser(page);
        });

        test("Home has no horizontal page overflow or desktop chrome", async ({
            page,
        }) => {
            await page.goto("/");
            await expect(
                page.locator('[data-shell-frame="mobile"]'),
            ).toBeVisible({ timeout: 30_000 });
            await expect(
                page.locator('[data-home-layout="personal-dashboard"]'),
            ).toBeVisible({ timeout: 30_000 });

            await expect(
                page.locator('[data-shell-sidebar="desktop"]'),
            ).toHaveCount(0);
            await expect(
                page.locator('[data-shell-topbar="desktop"]'),
            ).toHaveCount(0);
            await expect(
                page.locator('[data-shell-main-column="desktop"]'),
            ).toHaveCount(0);
            await expect(
                page.locator('[data-player-surface="desktop"]'),
            ).toHaveCount(0);
            await expect(
                page.locator('[data-shell-topbar="mobile"]'),
            ).toBeVisible();
            await expect(
                page.locator('[data-shell-bottom-navigation="true"]'),
            ).toBeVisible();

            await expect
                .poll(async () => (await pageOverflow(page)).horizontal)
                .toBeLessThanOrEqual(2);
        });
    });
});
