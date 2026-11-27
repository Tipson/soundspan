import { expect, type CDPSession, type Locator } from "@playwright/test";
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

async function swipe(
    session: CDPSession,
    start: { x: number; y: number },
    deltaX: number,
    deltaY: number,
) {
    await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [start],
    });
    for (let step = 1; step <= 10; step += 1) {
        await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
                {
                    x: start.x + (deltaX * step) / 10,
                    y: start.y + (deltaY * step) / 10,
                },
            ],
        });
    }
    await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
    });
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
        await expect(openPlayer).toBeFocused({ timeout: 3_000 });
        await page.keyboard.press("Space");
        await expect(player).toBeFocused({ timeout: 3_000 });
        await page.goBack();
        await expect(player).toHaveCount(0);
        await expect(openPlayer).toBeFocused();
        await openPlayer.tap();
        await expect(player).toBeVisible();
    });
}

test("a diagonal player scroll does not skip while horizontal swipes still skip", async ({
    page,
}) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await login(page);
    await page
        .locator('[data-home-made-card="core-mix-a"]')
        .getByRole("button")
        .click();
    await expectPlaying(page, TRACKS[0].id);
    await page.getByRole("button", { name: "Открыть плеер" }).tap();
    const player = page.locator('[data-player-surface="overlay"]');
    const title = player.getByRole("heading", { level: 1 });
    await expect(title).toHaveText(TRACKS[0].title);

    const session = await page.context().newCDPSession(page);
    await swipe(session, { x: 250, y: 360 }, -100, -180);
    const scrollArea = player.locator(".overlay-player-layout");
    await expect
        .poll(() => scrollArea.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(20);
    await expect(title).toHaveText(TRACKS[0].title, { timeout: 3_000 });

    await swipe(session, { x: 250, y: 190 }, -140, 0);
    await expect(title).toHaveText(TRACKS[1].title);
    await swipe(session, { x: 65, y: 190 }, 140, 0);
    await expect(title).toHaveText(TRACKS[0].title);
});
