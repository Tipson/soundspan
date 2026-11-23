import { expect } from "@playwright/test";
import { expectPlaying, login, readAudio, test, TRACKS } from "./fixture";

test("a denied future recommendation is skipped without playing its media", async ({
    page,
    app,
}) => {
    app.queueAdmissionDecisions = new Map([
        [`library:${TRACKS[1].id}`, "denied"],
    ]);
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
        .getByRole("button", { name: "Следующий трек", exact: true })
        .last()
        .click();
    await expectPlaying(page, TRACKS[2].id);
    expect(
        app.requests.some(
            (r) => r.path === `/api/library/tracks/${TRACKS[1].id}/stream`,
        ),
    ).toBe(false);
    expect(
        app.requests.some(
            (r) => r.path === "/api/personalized/queue-admission",
        ),
    ).toBe(true);
});

test("unavailable admission preserves the playing track and an explicit retry can advance", async ({
    page,
    app,
}) => {
    app.queueAdmissionStatus = 503;
    await login(page);
    await page
        .locator('[data-home-made-card="core-mix-a"]')
        .getByRole("button")
        .click();
    await expectPlaying(page, TRACKS[0].id);
    await page
        .getByRole("button", { name: "Открыть плеер", exact: true })
        .click();
    const response = page.waitForResponse(
        (r) =>
            r.url().endsWith("/api/personalized/queue-admission") &&
            r.status() === 503,
    );
    const since = (await readAudio(page, TRACKS[0].id))!.time;
    await page
        .getByRole("button", { name: "Следующий трек", exact: true })
        .last()
        .click();
    await response;
    await expectPlaying(page, TRACKS[0].id, since);
    expect(
        app.requests.some(
            (r) => r.path === `/api/library/tracks/${TRACKS[1].id}/stream`,
        ),
    ).toBe(false);
    app.queueAdmissionStatus = undefined;
    await page
        .getByRole("button", { name: "Следующий трек", exact: true })
        .last()
        .click();
    await expectPlaying(page, TRACKS[1].id);
});
