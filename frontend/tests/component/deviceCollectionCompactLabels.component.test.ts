import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

let storageStatus = "ready";
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        useDeviceOffline: () => ({
            enqueueCollection: async () => ({ queued: 1 }),
            collectionStatus: () => ({
                total: 1,
                ready: 0,
                autoReady: 0,
                queued: 0,
                processing: 0,
                errors: 0,
            }),
            storage: {
                status: storageStatus,
                explanation: "Полное объяснение доступности хранилища",
            },
        }),
    },
});

for (const [status, expectedLabel, accessibleDetail] of [
    ["ready", "Скачать", "Скачать Подборка на это устройство"],
    [
        "needs-setup",
        "Выбрать папку",
        "Выбрать папку и скачать Подборка на это устройство",
    ],
    [
        "error",
        "Подключить",
        "Подключить папку заново и скачать Подборка на это устройство",
    ],
    ["unsupported", "Недоступно", "Подборка нельзя скачать в этом браузере"],
]) {
    test(`collection ${status} uses a compact visible action without losing its explanation`, async () => {
        storageStatus = status;
        const { DeviceCollectionDownloadButton } =
            await import("../../features/device-offline/components/DeviceCollectionDownloadButton");
        const browser = new Window();
        try {
            browser.document.body.innerHTML = renderToStaticMarkup(
                React.createElement(DeviceCollectionDownloadButton, {
                    tracks: [
                        {
                            id: "local-test",
                            title: "Трек",
                            duration: 180,
                            artist: { name: "Артист" },
                            album: { title: "Альбом" },
                        },
                    ],
                    collectionId: "compact-label-test",
                    collectionLabel: "Подборка",
                }),
            );
            const button = browser.document.querySelector("button")!;
            assert.equal(button.textContent, expectedLabel);
            assert.equal(button.getAttribute("aria-label"), accessibleDetail);
            const description = browser.document.getElementById(
                button.getAttribute("aria-describedby")!,
            );
            assert.match(
                description?.textContent ?? "",
                /Полное объяснение доступности хранилища/,
            );
            assert.equal(button.disabled, status === "unsupported");
        } finally {
            await browser.happyDOM.close();
        }
    });
}
