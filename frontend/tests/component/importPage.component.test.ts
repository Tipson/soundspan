import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const executeCalls: Array<{ previewData: any; name?: string }> = [];
const previewCalls: string[] = [];
const m3uPreviewCalls: Array<{ content: string; name?: string }> = [];
const backgroundJobCalls: Array<{ url: string; name?: string }> = [];
const toastErrors: string[] = [];
const toastSuccesses: string[] = [];
const routerReplaceCalls: Array<{
    href: string;
    options?: { scroll?: boolean };
}> = [];
let invalidatedQueries: unknown[] = [];
let holdBackgroundJobSubmission = false;
let releaseBackgroundJobSubmission: (() => void) | null = null;
let searchParamsValue = "";

const previewResponse = {
    playlistName: "Test Playlist",
    resolved: [
        {
            index: 0,
            artist: "Local Artist",
            title: "Local Song",
            source: "local" as const,
            confidence: 100,
            trackId: "track-1",
        },
    ],
    summary: { total: 1, local: 1, youtube: 0, tidal: 0, unresolved: 0 },
};

mock.module("@/lib/api", {
    namedExports: {
        api: {
            previewPlaylistImport: async (url: string) => {
                previewCalls.push(url);
                return previewResponse;
            },
            previewM3UImport: async (content: string, name?: string) => {
                m3uPreviewCalls.push({ content, name });
                return {
                    ...previewResponse,
                    playlistName: name || previewResponse.playlistName,
                };
            },
            executePlaylistImport: async (input: {
                previewData: any;
                name?: string;
            }) => {
                executeCalls.push(input);
                return {
                    playlistId: "playlist-123",
                    summary: {
                        total: 4,
                        local: 1,
                        youtube: 1,
                        tidal: 1,
                        unresolved: 1,
                    },
                };
            },
            submitImportJob: async (url: string, name?: string) => {
                backgroundJobCalls.push({ url, name });
                if (holdBackgroundJobSubmission) {
                    await new Promise<void>((resolve) => {
                        releaseBackgroundJobSubmission = resolve;
                    });
                }
                return {
                    deduped: false,
                    job: { id: "job-123" },
                };
            },
        },
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            back: () => undefined,
            push: () => undefined,
            replace: (href: string, options?: { scroll?: boolean }) => {
                routerReplaceCalls.push({ href, options });
            },
        }),
        useSearchParams: () => new URLSearchParams(searchParamsValue),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: (message: string) => toastErrors.push(message),
                info: () => undefined,
                success: (message: string) => toastSuccesses.push(message),
            },
        }),
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YOUTUBE"),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    releaseBackgroundJobSubmission?.();
    holdBackgroundJobSubmission = false;
    releaseBackgroundJobSubmission = null;
    searchParamsValue = "";
    executeCalls.length = 0;
    previewCalls.length = 0;
    m3uPreviewCalls.length = 0;
    backgroundJobCalls.length = 0;
    toastErrors.length = 0;
    toastSuccesses.length = 0;
    routerReplaceCalls.length = 0;
    invalidatedQueries = [];
    document.body.replaceChildren();
});

async function mountImportPage() {
    const { default: ImportPage } = await import("../../app/import/page");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient();
    queryClient.invalidateQueries = (async (filters: unknown) => {
        invalidatedQueries.push(filters);
    }) as typeof queryClient.invalidateQueries;

    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(ImportPage),
            ),
        );
    });

    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes(text),
    );
    assert.ok(button instanceof HTMLButtonElement, `button not found: ${text}`);
    return button;
}

test("explains Spotify import boundaries and names the back button", async () => {
    const { container, unmount } = await mountImportPage();

    assert.ok(container.querySelector('[data-consumer-surface="import"]'));
    assert.ok(container.querySelector('[data-page-header="editorial"]'));
    const modeTabs = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    assert.equal(modeTabs.length, 2);
    assert.ok(modeTabs.every((tab) => tab.className.includes("min-h-11")));
    assert.ok(container.querySelector('button[aria-label="Назад"]'));
    assert.match(
        container.textContent || "",
        /Spotify используется только для чтения списка треков из публичного плейлиста/i,
    );
    assert.match(
        container.textContent || "",
        /не воспроизводит музыку из Spotify, не изменяет исходный плейлист и не сохраняет аудиофайлы на сервере/i,
    );
    assert.match(
        container.textContent || "",
        /Приватные плейлисты пока не поддерживаются/i,
    );

    await unmount();
});

test("imports a public Spotify playlist link without an OAuth connection", async () => {
    const harness = await mountImportPage();
    try {
        assert.doesNotMatch(
            harness.container.textContent || "",
            /Connect Spotify|Spotify playlist access/i,
        );
        const input = harness.container.querySelector(
            'input[placeholder^="Вставьте ссылку"]',
        );
        assert.ok(input instanceof HTMLInputElement, "playlist input missing");
        await React.act(async () => {
            typeInto(
                input,
                "https://open.spotify.com/playlist/7jKitT906pkaQtjZrvqn45",
            );
        });

        await click(findButton(harness.container, "Начать импорт"));
        assert.deepEqual(backgroundJobCalls, [
            {
                url: "https://open.spotify.com/playlist/7jKitT906pkaQtjZrvqn45",
                name: undefined,
            },
        ]);
    } finally {
        await harness.unmount();
    }
});

test("preview list renders provider resolution badges per track", async () => {
    const { PreviewTrackResolutionList } =
        await import("../../app/import/page");

    const html = renderToStaticMarkup(
        React.createElement(PreviewTrackResolutionList, {
            tracks: [
                {
                    index: 0,
                    artist: "Local Artist",
                    title: "Local Song",
                    source: "local",
                    confidence: 98,
                },
                {
                    index: 1,
                    artist: "YT Artist",
                    title: "YT Song",
                    source: "youtube",
                    confidence: 85,
                },
                {
                    index: 2,
                    artist: "Tidal Artist",
                    title: "Tidal Song",
                    source: "tidal",
                    confidence: 85,
                },
                {
                    index: 3,
                    artist: "Unknown Artist",
                    title: "Unknown Song",
                    source: "unresolved",
                    confidence: 0,
                },
            ],
        }),
    );

    assert.match(html, /ЛОКАЛЬНО/);
    assert.match(html, /YOUTUBE/);
    assert.match(html, /TIDAL/);
    assert.match(html, /НЕ НАЙДЕНО/);
    assert.match(html, /Совпадение у провайдеров не найдено/);
});

test("execute import action sends previewData instead of URL", async () => {
    const { executeImportAction } = await import("../../app/import/page");

    const previewData = {
        playlistName: "Test Playlist",
        resolved: [
            {
                index: 0,
                artist: "A1",
                title: "T1",
                source: "local" as const,
                confidence: 100,
                trackId: "track_1",
            },
        ],
        summary: { total: 1, local: 1, youtube: 0, tidal: 0, unresolved: 0 },
    };

    await executeImportAction({
        previewData,
        name: "  Imported Playlist  ",
    });

    assert.equal(executeCalls.length, 1);
    assert.deepEqual(executeCalls[0].previewData, previewData);
    assert.equal(executeCalls[0].name, "Imported Playlist");
});

test("keeps M3U preview and invalidates personalized home after import", async () => {
    const harness = await mountImportPage();
    const NativeFileReader = globalThis.FileReader;
    try {
        class ImmediateFileReader {
            result: string | ArrayBuffer | null = null;
            onload: ((event: Event) => void) | null = null;
            onerror: ((event: Event) => void) | null = null;

            readAsText(): void {
                this.result =
                    "#EXTM3U\n#EXTINF:180,Artist - Track\n/music/track.mp3\n";
                this.onload?.(new Event("load"));
            }
        }
        Object.defineProperty(globalThis, "FileReader", {
            configurable: true,
            value: ImmediateFileReader,
        });

        await click(findButton(harness.container, "Файл M3U"));
        const input = harness.container.querySelector('input[type="file"]');
        assert.ok(input instanceof HTMLInputElement, "M3U input missing");
        const file = new File(
            ["#EXTM3U\n#EXTINF:180,Artist - Track\n/music/track.mp3\n"],
            "road-trip.m3u",
            { type: "audio/x-mpegurl" },
        );
        Object.defineProperty(input, "files", {
            configurable: true,
            value: [file],
        });
        await React.act(async () => {
            input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await click(findButton(harness.container, "Предпросмотр импорта"));
        await click(findButton(harness.container, "Создать плейлист"));

        assert.equal(m3uPreviewCalls.length, 1);
        assert.deepEqual(invalidatedQueries, [
            { queryKey: ["home", "personalized"] },
        ]);
    } finally {
        Object.defineProperty(globalThis, "FileReader", {
            configurable: true,
            value: NativeFileReader,
        });
        await harness.unmount();
    }
});

test("isSupportedPlaylistUrl accepts Spotify intl playlist URLs", async () => {
    const { isSupportedPlaylistUrl } = await import("../../app/import/page");
    const intlSpotifyUrl =
        "https://open.spotify.com/intl-en/playlist/37i9dQZF1DXcBWIGoYBM5M";

    assert.equal(isSupportedPlaylistUrl(intlSpotifyUrl), true);
});

test("isSupportedPlaylistUrl rejects arbitrary text containing provider host fragments", async () => {
    const { isSupportedPlaylistUrl } = await import("../../app/import/page");
    const malformedValue =
        "not-a-url open.spotify.com/playlist/ definitely-not-valid";

    assert.equal(isSupportedPlaylistUrl(malformedValue), false);
});

test("isSupportedPlaylistUrl rejects non-HTTP executable URL schemes", async () => {
    const { isSupportedPlaylistUrl } = await import("../../app/import/page");
    const unsafeUrls = [
        "javascript://open.spotify.com/playlist/playlist123",
        "data://open.spotify.com/playlist/playlist123",
        "vbscript://open.spotify.com/playlist/playlist123",
    ];

    for (const unsafeUrl of unsafeUrls) {
        assert.equal(isSupportedPlaylistUrl(unsafeUrl), false, unsafeUrl);
    }
});

test("starts a durable background import without waiting for playlist preview", async () => {
    const harness = await mountImportPage();
    try {
        const input = harness.container.querySelector(
            'input[placeholder^="Вставьте ссылку"]',
        );
        assert.ok(input instanceof HTMLInputElement, "playlist input missing");

        await React.act(async () => {
            typeInto(
                input,
                " open.spotify.com/playlist/7jKitT906pkaQtjZrvqn45 ",
            );
        });
        await click(findButton(harness.container, "Начать импорт"));

        assert.deepEqual(backgroundJobCalls, [
            {
                url: "https://open.spotify.com/playlist/7jKitT906pkaQtjZrvqn45",
                name: undefined,
            },
        ]);
        assert.equal(previewCalls.length, 0);
        assert.doesNotMatch(
            harness.container.textContent ?? "",
            /Preview Tracks First/i,
        );
        assert.match(
            toastSuccesses[0] ?? "",
            /вкладке импорта в панели активности/,
        );
    } finally {
        await harness.unmount();
    }
});

test("rapid import clicks submit only one background job", async () => {
    const harness = await mountImportPage();
    try {
        const input = harness.container.querySelector(
            'input[placeholder^="Вставьте ссылку"]',
        );
        assert.ok(input instanceof HTMLInputElement, "playlist input missing");
        await React.act(async () => {
            typeInto(
                input,
                "https://open.spotify.com/playlist/7jKitT906pkaQtjZrvqn45",
            );
        });
        holdBackgroundJobSubmission = true;
        const button = findButton(harness.container, "Начать импорт");

        await React.act(async () => {
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await Promise.resolve();
        });

        assert.equal(backgroundJobCalls.length, 1);
        releaseBackgroundJobSubmission?.();
        await React.act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
    } finally {
        releaseBackgroundJobSubmission?.();
        await harness.unmount();
    }
});

test("a URL query parameter starts the same durable background import", async () => {
    const playlistUrl =
        "https://open.spotify.com/playlist/7jKitT906pkaQtjZrvqn45";
    searchParamsValue = `?url=${encodeURIComponent(playlistUrl)}`;
    const harness = await mountImportPage();
    try {
        for (
            let attempt = 0;
            attempt < 10 && backgroundJobCalls.length === 0;
            attempt += 1
        ) {
            await React.act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
            });
        }

        assert.deepEqual(backgroundJobCalls, [
            { url: playlistUrl, name: undefined },
        ]);
        assert.equal(previewCalls.length, 0);
    } finally {
        await harness.unmount();
    }
});

test("successful background submission notifies an open Imports activity tab", async () => {
    const harness = await mountImportPage();
    let eventCount = 0;
    let submittedJobId: unknown;
    const handleChanged = (event: Event) => {
        eventCount += 1;
        submittedJobId = (event as CustomEvent<{ jobId?: unknown }>).detail
            ?.jobId;
    };
    window.addEventListener("import-jobs-changed", handleChanged);
    try {
        const input = harness.container.querySelector(
            'input[placeholder^="Вставьте ссылку"]',
        );
        assert.ok(input instanceof HTMLInputElement, "playlist input missing");
        await React.act(async () => {
            typeInto(
                input,
                "https://open.spotify.com/playlist/7jKitT906pkaQtjZrvqn45",
            );
        });
        await click(findButton(harness.container, "Начать импорт"));

        assert.equal(eventCount, 1);
        assert.equal(submittedJobId, "job-123");
    } finally {
        window.removeEventListener("import-jobs-changed", handleChanged);
        await harness.unmount();
    }
});

test("background import submits only the canonical HTTP(S) URL", async () => {
    const cases = [
        {
            input: "  HTTP://OPEN.SPOTIFY.COM:80/playlist/AbC123  ",
            canonical: "http://open.spotify.com/playlist/AbC123",
        },
        {
            input: "HTTPS://MUSIC.YOUTUBE.COM:443/playlist?list=PL123",
            canonical: "https://music.youtube.com/playlist?list=PL123",
        },
    ];

    for (const testCase of cases) {
        const harness = await mountImportPage();
        try {
            const input = harness.container.querySelector(
                'input[placeholder^="Вставьте ссылку"]',
            );
            assert.ok(
                input instanceof HTMLInputElement,
                "playlist input missing",
            );

            await React.act(async () => {
                typeInto(input, testCase.input);
            });
            await click(findButton(harness.container, "Начать импорт"));

            assert.equal(backgroundJobCalls.at(-1)?.url, testCase.canonical);
            assert.equal(previewCalls.length, 0);
        } finally {
            await harness.unmount();
        }
    }
});
