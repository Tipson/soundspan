import { expect } from "@playwright/test";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import {
    createSyntheticWav,
    fulfillAudioRange,
} from "../fixtures/syntheticAudio";
import { expectPlaying, login, test, TRACKS } from "./fixture";

const VERSION_ID = "7ced2bb5-2299-43f9-b036-587cd5b50f27";
const TARGET_PATH = `/api/track-audio/library/${TRACKS[0].id}`;
const VERSION_PATH = `/api/track-audio/versions/${VERSION_ID}/stream`;
const at = (path: string) => (url: URL) =>
    url.origin === CORE_ORIGIN && url.pathname === path;

test("published track audio plays by default and an ordinary account cannot manage it", async ({
    page,
    app,
}) => {
    await page.route(at(TARGET_PATH), async (route) => {
        expect(route.request().method()).toBe("GET");
        await route.fulfill({ json: { publishedId: VERSION_ID } });
    });
    const audio = createSyntheticWav(45);
    await page.route(at(VERSION_PATH), (route) =>
        fulfillAudioRange(route, audio),
    );
    await login(page);
    await page
        .locator('[data-home-made-card="core-mix-a"]')
        .getByRole("button")
        .click();
    await expectPlaying(page, VERSION_PATH);
    await page
        .getByRole("button", { name: "Открыть плеер", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Действия с треком", exact: true })
        .last()
        .click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(
        page.getByRole("menuitem", { name: "Полная версия трека" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page
        .getByRole("button", { name: "Следующий трек", exact: true })
        .last()
        .click();
    await expectPlaying(page, TRACKS[1].id);
    expect(app.requests).not.toContainEqual({
        method: "GET",
        path: `/api/library/tracks/${TRACKS[0].id}/stream`,
        search: "",
    });
});

test("an administrator can stage and publish audio from the track menu", async ({
    page,
    app,
}) => {
    app.role = "admin";
    const upload = Buffer.from("core-fixture-track-audio");
    await page.route(at("/api/downloads"), (route) =>
        route.fulfill({ json: [] }),
    );
    await page.route(at("/api/downloads/availability"), (route) =>
        route.fulfill({
            json: {
                enabled: false,
                lidarr: false,
                soulseek: false,
                tidal: false,
                youtube: false,
            },
        }),
    );
    await page.route(at(`${TARGET_PATH}/manage`), async (route) => {
        expect(route.request().method()).toBe("GET");
        expect(route.request().headers().authorization).toBe(
            "Bearer core-regression-token",
        );
        await route.fulfill({ json: { draftId: null, publishedId: null } });
    });
    await page.route(at(`${TARGET_PATH}/draft`), async (route) => {
        expect(route.request().method()).toBe("PUT");
        expect(route.request().headers()["content-type"]).toBe("audio/mpeg");
        expect(route.request().postDataBuffer()).toEqual(upload);
        await route.fulfill({
            status: 201,
            json: { draftId: VERSION_ID, publishedId: null },
        });
    });
    await page.route(at(`${TARGET_PATH}/publish`), async (route) => {
        expect(route.request().method()).toBe("POST");
        expect(route.request().postDataJSON()).toEqual({
            versionId: VERSION_ID,
        });
        await route.fulfill({
            json: { draftId: null, publishedId: VERSION_ID },
        });
    });
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
        .getByRole("menuitem", { name: "Полная версия трека", exact: true })
        .click();
    const dialog = page.getByRole("dialog", { name: "Полная версия трека" });
    await expect(
        dialog.getByText(TRACKS[0].title, { exact: true }),
    ).toBeVisible();
    await dialog.getByLabel("Аудиофайл MP3 до 16 МиБ").setInputFiles({
        name: "full-version.mp3",
        mimeType: "audio/mpeg",
        buffer: upload,
    });
    await dialog.getByRole("button", { name: "Загрузить черновик" }).click();
    await expect(dialog.getByLabel("Прослушать черновик")).toHaveAttribute(
        "src",
        VERSION_PATH,
    );
    await dialog.getByRole("button", { name: "Опубликовать для всех" }).click();
    await expect(dialog.getByLabel("Прослушать черновик")).toHaveCount(0);
    await expect(
        dialog.getByLabel("Прослушать опубликованную версию"),
    ).toHaveAttribute("src", VERSION_PATH);
});
