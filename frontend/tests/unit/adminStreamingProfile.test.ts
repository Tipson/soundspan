import assert from "node:assert/strict";
import test from "node:test";
import { getPersonalStreamingAdminSidebarItems } from "../../features/settings/personalStreamingAdminSections";

test("админка показывает защиту медиатеки без скрытых серверных разделов", () => {
    const sidebarItems = getPersonalStreamingAdminSidebarItems(false);
    const sectionIds = sidebarItems.map((item) => item.id);

    assert.deepEqual(sectionIds, [
        "playback-sources",
        "youtube-music-admin",
        "ai-services",
        "cache",
        "library-safety",
        "users",
    ]);
    assert.equal(
        sidebarItems.find((item) => item.id === "library-safety")?.label,
        "Защита серверной медиатеки",
    );

    for (const dormantSectionId of [
        "download-preferences",
        "download-services",
        "storage",
        "library-health",
        "library-insights",
    ]) {
        assert.equal(sectionIds.includes(dormantSectionId), false);
    }
});

test("админка добавляет федерацию после основных защитных настроек", () => {
    const sidebarItems = getPersonalStreamingAdminSidebarItems(true);

    assert.equal(sidebarItems.at(-1)?.id, "federation");
    assert.equal(
        sidebarItems.some((item) => item.id === "library-safety"),
        true,
    );
});
