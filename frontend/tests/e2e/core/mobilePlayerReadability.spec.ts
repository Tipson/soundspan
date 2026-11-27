import { expect, type Locator } from "@playwright/test";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import { expectPlaying, login, test, TRACKS } from "./fixture";

const title = "Путешествие к северному сиянию ночью";
const artist = "Оркестр северного побережья и его друзья";

async function expectTextFits(locator: Locator) {
    await expect(locator).toBeInViewport({ ratio: 1 });
    const { height, scrollHeight, width, scrollWidth } = await locator.evaluate(
        (element) => ({
            height: element.clientHeight,
            scrollHeight: element.scrollHeight,
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
        }),
    );
    expect(scrollWidth).toBeLessThanOrEqual(width + 1);
    expect(scrollHeight).toBeLessThanOrEqual(height + 2);
}

async function openPlayerAndReadStartingOpacity(trigger: Locator) {
    return trigger.evaluate(
        (button) =>
            new Promise<number>((resolve) => {
                const observer = new MutationObserver(() => {
                    const surface = document.querySelector(
                        '[data-player-surface="overlay"]',
                    );
                    if (!surface?.parentElement) return;
                    observer.disconnect();
                    resolve(
                        Number(getComputedStyle(surface).opacity) *
                            Number(
                                getComputedStyle(surface.parentElement).opacity,
                            ),
                    );
                });
                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                });
                (button as HTMLButtonElement).click();
            }),
    );
}

for (const viewport of [
    { width: 320, height: 568 },
    { width: 360, height: 640 },
    { width: 390, height: 844 },
]) {
    test(`mobile full player keeps Russian metadata and transport reachable at ${viewport.width}px`, async ({
        page,
    }) => {
        await page.setViewportSize(viewport);
        if (viewport.width === 360) {
            await page.emulateMedia({ reducedMotion: "reduce" });
        }
        const first = TRACKS[0];
        await page.route(
            `${CORE_ORIGIN}/api/personalized/daily-mixes`,
            (route) =>
                route.fulfill({
                    json: {
                        mixes: [
                            {
                                key: "core-mix-a",
                                title: "Тестовый микс A",
                                description: "",
                                tracks: [
                                    {
                                        ...first,
                                        title,
                                        artist: {
                                            ...first.artist,
                                            name: artist,
                                        },
                                    },
                                    ...TRACKS.slice(1, 20),
                                ],
                            },
                        ],
                    },
                }),
        );
        await login(page);
        await page
            .locator('[data-home-made-card="core-mix-a"]')
            .getByRole("button")
            .click();
        await expectPlaying(page, first.id);
        const openPlayer = page.getByRole("button", { name: "Открыть плеер" });
        await expect.soft(openPlayer.getByRole("button")).toHaveCount(0, {
            timeout: 500,
        });
        expect.soft(await openPlayerAndReadStartingOpacity(openPlayer)).toBe(1);

        const player = page.locator('[data-player-surface="overlay"]');
        await expectTextFits(player.getByRole("heading", { name: title }));
        await expectTextFits(player.getByText(artist, { exact: true }));

        await player.getByRole("button", { name: "Следующий трек" }).click();
        await expectPlaying(page, TRACKS[1].id);

        await page.keyboard.press("Escape");
        await expect(player).toHaveCount(0);
        await openPlayer.tap();
        await expect(player).toBeVisible();
    });
}
