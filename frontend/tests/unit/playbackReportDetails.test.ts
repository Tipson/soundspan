import assert from "node:assert/strict";
import test from "node:test";
import { playbackReportDetails } from "../../components/activity/playbackReportDetails";
test("admin details show useful evidence without arbitrary metadata", () => {
    const details = playbackReportDetails({
        fields: {
            reportTrackId: "vk:1_2",
            currentTimeSec: 12,
            localSource: true,
            online: false,
            frontendBuildId: "build123",
            token: "secret",
            url: "https://private",
        },
    });
    assert.deepEqual(details, [
        ["Трек", "vk:1_2"],
        ["Позиция", "12 с"],
        ["Источник", "На устройстве"],
        ["Интернет", "Нет"],
        ["Сборка", "build123"],
    ]);
    assert.deepEqual(playbackReportDetails(null), []);
    assert.deepEqual(
        playbackReportDetails({
            fields: { reportTrackId: "https://private", currentTimeSec: -1 },
        }),
        [],
    );
});
