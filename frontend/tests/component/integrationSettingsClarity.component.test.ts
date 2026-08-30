import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemSettings } from "../../features/settings/types";

const uiModule = new URL(
    "../../features/settings/components/ui/index.ts",
    import.meta.url,
).href;
const lidarrModule = new URL(
    "../../features/settings/components/sections/LidarrSection.tsx",
    import.meta.url,
).href;
const soulseekModule = new URL(
    "../../features/settings/components/sections/SoulseekSection.tsx",
    import.meta.url,
).href;
const tidalModule = new URL(
    "../../features/settings/components/sections/TidalSection.tsx",
    import.meta.url,
).href;

mock.module(uiModule, {
    namedExports: {
        SettingsSection: ({
            title,
            description,
            children,
        }: {
            title: string;
            description: string;
            children: React.ReactNode;
        }) =>
            React.createElement(
                "section",
                null,
                React.createElement("h2", null, title),
                React.createElement("p", null, description),
                children,
            ),
        SettingsRow: ({
            label,
            description,
            children,
        }: {
            label: string;
            description?: React.ReactNode;
            children: React.ReactNode;
        }) =>
            React.createElement(
                "div",
                null,
                React.createElement("span", null, label),
                description,
                children,
            ),
        SettingsSelect: ({ value }: { value: string }) =>
            React.createElement("span", null, value),
        SettingsToggle: ({ checked }: { checked: boolean }) =>
            React.createElement("span", null, checked ? "enabled" : "disabled"),
        SettingsInput: ({ value }: { value: string }) =>
            React.createElement("span", null, value),
        IntegrationCard: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", null, children),
        DeviceAuthLinkPanel: () => React.createElement("div"),
    },
});

for (const [moduleUrl, exportName, label] of [
    [lidarrModule, "LidarrCard", "Lidarr"],
    [soulseekModule, "SoulseekCard", "Soulseek"],
    [tidalModule, "TidalCard", "TIDAL"],
] as const) {
    mock.module(moduleUrl, {
        namedExports: {
            [exportName]: () => React.createElement("div", null, label),
        },
    });
}

test("separates optional server downloads from the active streaming stack", async () => {
    const { DownloadServicesSection } =
        await import("../../features/settings/components/sections/DownloadServicesSection");
    const html = renderToStaticMarkup(
        React.createElement(DownloadServicesSection, {
            settings: { ytMusicEnabled: true } as SystemSettings,
            onUpdate: () => undefined,
            onTest: async () => ({ success: true }),
            testingServices: {},
        }),
    );

    assert.match(html, /Additional Server Download Services/);
    assert.match(
        html,
        /YouTube Music already provides worldwide search and streaming/,
    );
    assert.match(html, /explicitly request a permanent server copy/);
    assert.match(
        html,
        /not required for playlist import or offline downloads on your phone/i,
    );
});

test("explains that playback source order is not connection status", async () => {
    const { PlaybackSourcesSection } =
        await import("../../features/settings/components/sections/PlaybackSourcesSection");
    const html = renderToStaticMarkup(
        React.createElement(PlaybackSourcesSection, {
            settings: {
                playbackSourceOrder: "library,peers,tidal,ytmusic",
            } as SystemSettings,
            onUpdate: () => undefined,
        }),
    );

    assert.match(html, /Это приоритет, а не список подключений/i);
    assert.match(html, /недоступные и отключённые источники пропускаются/i);
});

test("separates active public YouTube Music access from optional account linking", async () => {
    const { YouTubeMusicAdminSection } =
        await import("../../features/settings/components/sections/YouTubeMusicSection");
    const html = renderToStaticMarkup(
        React.createElement(YouTubeMusicAdminSection, {
            settings: {
                ytMusicEnabled: true,
                ytMusicClientId: "",
                ytMusicClientSecret: "",
            } as SystemSettings,
            onUpdate: () => undefined,
        }),
    );

    assert.match(
        html,
        /Публичный поиск, каталог и воспроизведение работают без привязки Google-аккаунта/,
    );
    assert.match(
        html,
        /Привязка необязательна и добавляет доступ к личной медиатеке/,
    );
    assert.match(
        html,
        /Для части контента и функций может потребоваться YouTube Music Premium/,
    );
    assert.doesNotMatch(
        html,
        /A YouTube Music Premium subscription is required/,
    );
});
