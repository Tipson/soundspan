import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SystemSettings } from "../../features/settings/types";

const activeMigration = {
    spaceId: "space-migrating",
    family: "student",
    coverage: { embedded: 80, pending: 20, failed: 3 },
    cutoverThreshold: 0.95,
};
let migration: typeof activeMigration | null = activeMigration;

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({
            musicCNN: true,
            vibeEmbeddings: true,
            audioAnalysis: true,
            discovery: true,
            autoPlaylists: true,
            federation: false,
            vibe: {
                provider: {
                    configured: true,
                    reachable: true,
                    checkedAt: "2026-08-17T12:00:00.000Z",
                    fresh: true,
                },
                activeSpace: { id: "space-active", family: "teacher" },
                migration,
            },
            showVersion: false,
            loading: false,
        }),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        }),
    },
});

mock.module("@/components/EnrichmentFailuresModal", {
    namedExports: {
        EnrichmentFailuresModal: () => null,
    },
});

const settings: SystemSettings = {
    lidarrEnabled: false,
    lidarrUrl: "",
    lidarrApiKey: "",
    openaiEnabled: false,
    openaiApiKey: "",
    openaiModel: "",
    fanartEnabled: false,
    fanartApiKey: "",
    lastfmApiKey: "",
    audiobookshelfEnabled: false,
    audiobookshelfUrl: "",
    audiobookshelfApiKey: "",
    soulseekUsername: "",
    soulseekPassword: "",
    tidalEnabled: false,
    tidalConnected: false,
    tidalUserId: "",
    tidalCountryCode: "US",
    tidalQuality: "HIGH",
    tidalFileTemplate: "",
    musicPath: "/music",
    downloadPath: "/downloads",
    transcodeCacheMaxGb: 10,
    maxCacheSizeMb: 1024,
    autoSync: true,
    autoEnrichMetadata: true,
    libraryDeletionEnabled: false,
    audioAnalyzerWorkers: 2,
    soulseekConcurrentDownloads: 4,
    downloadSource: "soulseek",
    federationInstanceName: null,
    playbackSourceOrder: "library,peers,tidal,ytmusic",
    primaryFailureFallback: "none",
    ytMusicEnabled: false,
    ytMusicClientId: "",
    ytMusicClientSecret: "",
    showVersion: false,
};

async function renderCacheSection(options?: {
    emptyAudio?: boolean;
    artistProgress?: {
        completed: number;
        total: number;
        progress: number;
        failed: number;
    };
}): Promise<string> {
    const { CacheSection } =
        await import("../../features/settings/components/sections/CacheSection");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["enrichment-progress"], {
        artists: options?.artistProgress ?? {
            completed: 2,
            total: 2,
            progress: 100,
            failed: 0,
        },
        trackTags: { completed: 2, total: 2, progress: 100, failed: 0 },
        audioAnalysis: {
            completed: options?.emptyAudio ? 0 : 2,
            total: options?.emptyAudio ? 0 : 2,
            progress: options?.emptyAudio ? 0 : 100,
            processing: 0,
            failed: 0,
        },
        clapEmbeddings: {
            completed: options?.emptyAudio ? 0 : 1,
            total: options?.emptyAudio ? 0 : 2,
            progress: options?.emptyAudio ? 0 : 50,
            processing: options?.emptyAudio ? 0 : 1,
            failed: 0,
        },
        coreComplete: true,
        isFullyComplete: false,
    });

    return renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(CacheSection, {
                settings,
                onUpdate: () => undefined,
            }),
        ),
    );
}

test("renders live vibe embedding progress in Russian without the retired worker control", async () => {
    migration = activeMigration;
    const html = await renderCacheSection();

    assert.match(html, /Vibe-эмбеддинги/);
    assert.match(html, /Кэш и автоматизация/);
    assert.match(html, /Обогащение медиатеки/);
    assert.match(html, /Размер пользовательского кэша/);
    assert.match(html, /Провайдер\s+доступен/);
    assert.match(html, /Миграция эмбеддингов/);
    assert.match(html, /Целевое семейство пространства:\s*student/);
    assert.match(html, /80%/);
    assert.match(html, /ошибок:\s*3/);
    assert.match(html, /Порог переключения:\s*95%/);
    assert.match(html, /Запустить заново/);
    assert.doesNotMatch(html, /Vibe Embedding Workers/);
    assert.doesNotMatch(
        html,
        /Cache &amp; Automation|Library Enrichment|User cache size|Clear All Caches/,
    );
});

test("hides migration progress when no migration is active", async () => {
    migration = null;

    const html = await renderCacheSection();

    assert.doesNotMatch(html, /Миграция эмбеддингов/);
    assert.doesNotMatch(html, /Целевое семейство пространства:/);
});

test("displays 99 percent when rounded progress is 100 but work remains", async () => {
    const html = await renderCacheSection({
        artistProgress: {
            completed: 999,
            total: 1000,
            progress: 100,
            failed: 0,
        },
    });

    assert.match(
        html,
        /Метаданные исполнителей[\s\S]*?style="width:99%"[\s\S]*?99%/,
    );
});

test("empty local analysis is not presented as completed online analysis", async () => {
    migration = null;
    const html = await renderCacheSection({ emptyAudio: true });
    const audio = html.slice(
        html.indexOf('aria-label="Аудиоанализ локальных файлов"'),
        html.indexOf('aria-label="Vibe-эмбеддинги локальных файлов"'),
    );
    assert.ok(audio.length > 0);
    assert.match(audio, /Нет локальных аудиофайлов/);
    assert.doesNotMatch(audio, /text-success|0%|0 \/ 0/);
    assert.match(html, /Онлайн-треки анализируются отдельным конвейером/);
});
