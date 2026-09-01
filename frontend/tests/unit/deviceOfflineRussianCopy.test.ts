import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("PWA manifest exposes Russian descriptions and shortcut names", () => {
    const manifest = JSON.parse(
        readFileSync(
            new URL("../../public/manifest.webmanifest", import.meta.url),
            "utf8",
        ),
    ) as {
        description: string;
        shortcuts: Array<{ name: string; short_name: string }>;
    };

    assert.equal(manifest.description, "Слушайте без ограничений");
    assert.deepEqual(
        manifest.shortcuts.map(({ name, short_name: shortName }) => ({
            name,
            shortName,
        })),
        [
            { name: "Поиск", shortName: "Поиск" },
            { name: "Коллекция", shortName: "Коллекция" },
            { name: "Загрузки", shortName: "Загрузки" },
        ],
    );
});

test("offline runtime no longer contains the audited English user messages", () => {
    const files = [
        "../../features/device-offline/DeviceOfflineProvider.tsx",
        "../../features/device-offline/audioResponse.ts",
        "../../features/device-offline/browserQueueStorage.ts",
        "../../features/device-offline/browserStorage.ts",
        "../../features/device-offline/downloadError.ts",
        "../../features/device-offline/downloadManager.ts",
        "../../features/device-offline/legacyCacheMigration.ts",
        "../../features/device-offline/offlineQueue.ts",
        "../../features/device-offline/physicalFileExport.ts",
        "../../features/device-offline/platform.ts",
        "../../features/device-offline/playbackResolver.ts",
        "../../features/device-offline/sourceValidation.ts",
        "../../features/device-offline/trackIdentity.ts",
        "../../features/device-offline/vaultRetention.ts",
        "../../features/device-offline/vaultRecordAccess.ts",
        "../../features/device-offline/vaultRecordDeletion.ts",
        "../../features/device-offline/vault/browserDirectoryVault.ts",
        "../../features/device-offline/vault/browserPrivateVault.ts",
        "../../features/device-offline/vault/browserRuntime.ts",
        "../../features/device-offline/vault/index.ts",
        "../../features/device-offline/vault/indexedDbDirectoryRegistry.ts",
        "../../public/sw.js",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    const source = files.join("\n");

    for (const phrase of [
        "Keep soundspan open",
        "Download was interrupted",
        "Download failed",
        "This device copy",
        "Device files unavailable",
        "Choose a music folder",
        "Selected folder",
        "Music files are stored",
        "Soundspan could not",
        "You are offline",
        "My Liked",
        "The browser retained an empty audio response",
        "Not enough device storage",
        "Browser file downloads are unavailable",
        "Unknown artist",
        "Untitled",
        "Image unavailable",
        "Device audio unavailable",
        "Critical offline document failed",
        "Critical offline asset failed",
        "Background download could not be saved",
    ]) {
        assert.equal(source.includes(phrase), false, phrase);
    }
});
