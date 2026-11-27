import { expect } from "@playwright/test";
import { login, test } from "./fixture";

for (const width of [320, 360, 390]) {
    test.describe(`Mobile Settings at ${width}px`, () => {
        test.use({ viewport: { width, height: 720 } });

        test("shows the four destinations, keeps drafts and restores Back", async ({
            page,
        }) => {
            await login(page);
            await page.goto("/settings");
            const overview = page.getByRole("navigation", {
                name: "Разделы настроек",
            });
            const profile = overview.getByRole("link", { name: /^Профиль/ });
            await expect(overview.getByRole("link")).toHaveCount(4);
            await expect(
                page.getByRole("heading", { name: "Аккаунт", exact: true }),
            ).toBeHidden();

            await profile.click();
            await expect(page).toHaveURL(/\/settings#account$/);
            await expect(
                page.getByRole("heading", { name: "Профиль", exact: true }),
            ).toBeFocused();
            await page.locator("#display-name").fill("Черновик профиля");

            await page.goBack();
            await expect(page).toHaveURL(/\/settings$/);
            await expect(
                page.getByRole("heading", { name: "Настройки", exact: true }),
            ).toBeFocused();
            await expect(profile).toBeVisible();
            await expect(
                page.getByRole("button", { name: "Сохранить изменения" }),
            ).toBeVisible();

            await page.goForward();
            await expect(page.locator("#display-name")).toHaveValue(
                "Черновик профиля",
            );
            await page.getByRole("link", { name: "Все настройки" }).click();
            await expect(overview).toBeVisible();
        });

        test("fits Automatic volume leveling inside the playback card", async ({
            page,
        }) => {
            await login(page);
            await page.goto("/settings#playback");
            const level = page.locator("#playback select").nth(1);
            await expect(level).toHaveValue("auto");
            const dimensions = await level.evaluate(
                (select: HTMLSelectElement) => {
                    const style = getComputedStyle(select);
                    const context = document
                        .createElement("canvas")
                        .getContext("2d")!;
                    context.font = style.font;
                    return {
                        available:
                            select.clientWidth -
                            parseFloat(style.paddingLeft) -
                            parseFloat(style.paddingRight),
                        label: context.measureText(
                            select.selectedOptions[0]?.textContent ?? "",
                        ).width,
                        right: select.getBoundingClientRect().right,
                        fieldRight: select
                            .closest(".settings-row")!
                            .getBoundingClientRect().right,
                    };
                },
            );
            expect(dimensions.label).toBeLessThanOrEqual(
                dimensions.available + 1,
            );
            expect(dimensions.right).toBeLessThanOrEqual(
                dimensions.fieldRight + 1,
            );
        });
    });
}

test("opens legacy settings sections and exposes SSO callback feedback", async ({
    page,
}) => {
    await login(page);
    await page.goto("/settings#history");
    await expect(
        page.getByRole("heading", { name: "История и персонализация" }),
    ).toBeVisible();

    await page.goto("/settings#api-keys");
    await expect(
        page.getByRole("heading", { name: "Ключи API" }),
    ).toBeVisible();

    await page.goto("/settings?keep=1&ssoLinked=1");
    await expect(page.getByText("Аккаунт SSO подключён.")).toBeVisible();
    await expect(page).toHaveURL(/\/settings\?keep=1#sign-in-security$/);
});

test("restores mobile heading focus when traversing legacy settings links", async ({
    page,
}) => {
    await login(page);
    await page.goto("/settings#history");
    const listeningHeading = page.getByRole("heading", {
        name: "Прослушивание",
        exact: true,
    });
    const securityHeading = page.getByRole("heading", {
        name: "Безопасность",
        exact: true,
    });
    await expect(listeningHeading).toBeVisible();
    await expect(listeningHeading).not.toBeFocused();

    await page.goto("/settings#api-keys");
    await expect(securityHeading).toBeVisible();
    await page.getByRole("link", { name: "Все настройки" }).focus();
    await page.goBack();
    await expect(page).toHaveURL(/\/settings#history$/);
    await expect(listeningHeading).toBeFocused();

    await page.getByRole("link", { name: "Все настройки" }).focus();
    await page.goForward();
    await expect(page).toHaveURL(/\/settings#api-keys$/);
    await expect(securityHeading).toBeFocused();
});

test("regular accounts return to the settings overview from Admin", async ({
    page,
    app,
}) => {
    await login(page);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(
        page
            .getByRole("navigation", { name: "Разделы настроек" })
            .getByRole("link"),
    ).toHaveCount(4);
    expect(
        app.requests.some((request) => request.path === "/api/system-settings"),
    ).toBe(false);
});

test.describe("Desktop Settings", () => {
    test.use({ isMobile: false, viewport: { width: 1024, height: 800 } });

    test("keeps Profile open by default and supports arrow navigation", async ({
        page,
    }) => {
        await login(page);
        await page.goto("/settings");
        const profile = page.getByRole("tab", { name: "Профиль" });
        await expect(profile).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#display-name")).toBeVisible();
        await expect(
            page.getByRole("navigation", { name: "Разделы настроек" }),
        ).toBeHidden();

        await profile.focus();
        await profile.press("ArrowRight");
        await expect(
            page.getByRole("tab", { name: "Прослушивание" }),
        ).toBeFocused();
        await expect(page).toHaveURL(/\/settings#playback$/);
    });
});
