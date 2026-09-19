import { expect, test, type Page, type Route } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const TEST_USER_ID = "e2e-navigation-user";
const TEST_TRACK_ID = "e2e-navigation-track";
const NAVIGATION_COUNT = 50;

const TEST_TRACK = {
    id: TEST_TRACK_ID,
    title: "Navigation continuity tone",
    artist: { id: "e2e-artist", name: "Soundspan E2E" },
    album: { id: "e2e-album", title: "Synthetic fixtures", coverArt: null },
    duration: 120,
    filePath: "synthetic/navigation-continuity.wav",
};

interface InstrumentedWindow extends Window {
    __navigationPlaybackDocumentId: string;
    __navigationPlaybackAudioElements: HTMLAudioElement[];
    __navigationPlaybackPrimaryAudio?: HTMLAudioElement;
    __navigationPlaybackInitialAudioCount?: number;
    __navigationPlaybackInitialSrc?: string;
    __navigationPlaybackStarted?: boolean;
    __navigationPlaybackEvents: PlaybackEvent[];
}

interface PlaybackEvent {
    type: "pause" | "ended" | "emptied";
    currentTime: number;
}

interface AudioSample {
    documentId: string;
    audioCount: number;
    sameElement: boolean;
    initialElementOccurrences: number;
    matchingSourceCount: number;
    replacementSourceCount: number;
    currentTime: number;
    duration: number;
    paused: boolean;
    ended: boolean;
    readyState: number;
    networkState: number;
    src: string;
}

function createSyntheticWav(seconds = 120, sampleRate = 8_000): Buffer {
    const sampleCount = seconds * sampleRate;
    const buffer = Buffer.alloc(44 + sampleCount * 2);
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(buffer.length - 8, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(sampleCount * 2, 40);
    for (let index = 0; index < sampleCount; index += 1) {
        const sample = Math.round(
            Math.sin((index * Math.PI * 2 * 440) / sampleRate) * 2_000,
        );
        buffer.writeInt16LE(sample, 44 + index * 2);
    }
    return buffer;
}

async function fulfillAudioRange(route: Route, audio: Buffer): Promise<void> {
    const range = route.request().headers().range;
    const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
    if (!match) {
        await route.fulfill({
            status: 200,
            contentType: "audio/wav",
            headers: {
                "accept-ranges": "bytes",
                "cache-control": "no-store",
                "content-length": String(audio.length),
            },
            body: audio,
        });
        return;
    }

    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : audio.length - 1;
    const end = Math.min(requestedEnd, audio.length - 1);
    const body = audio.subarray(start, end + 1);
    await route.fulfill({
        status: 206,
        contentType: "audio/wav",
        headers: {
            "accept-ranges": "bytes",
            "cache-control": "no-store",
            "content-length": String(body.length),
            "content-range": `bytes ${start}-${end}/${audio.length}`,
        },
        body,
    });
}

async function readAudioSample(page: Page): Promise<AudioSample | null> {
    return page.evaluate((trackId) => {
        const instrumented = window as unknown as InstrumentedWindow;
        const candidate = instrumented.__navigationPlaybackAudioElements.find(
            (audio) => audio.src.includes(trackId),
        );
        const primary =
            instrumented.__navigationPlaybackPrimaryAudio ?? candidate;
        if (!primary) return null;
        const initial = instrumented.__navigationPlaybackPrimaryAudio;
        const initialSrc = instrumented.__navigationPlaybackInitialSrc;
        return {
            documentId: instrumented.__navigationPlaybackDocumentId,
            audioCount: instrumented.__navigationPlaybackAudioElements.length,
            sameElement: !initial || candidate === initial,
            initialElementOccurrences: initial
                ? instrumented.__navigationPlaybackAudioElements.filter(
                      (element) => element === initial,
                  ).length
                : 0,
            matchingSourceCount: initialSrc
                ? instrumented.__navigationPlaybackAudioElements.filter(
                      (element) => element.src === initialSrc,
                  ).length
                : 0,
            replacementSourceCount: initialSrc
                ? instrumented.__navigationPlaybackAudioElements.filter(
                      (element) =>
                          element !== initial && element.src === initialSrc,
                  ).length
                : 0,
            currentTime: primary.currentTime,
            duration: primary.duration,
            paused: primary.paused,
            ended: primary.ended,
            readyState: primary.readyState,
            networkState: primary.networkState,
            src: primary.src,
        };
    }, TEST_TRACK_ID);
}

async function lockInitialAudioEvidence(page: Page): Promise<void> {
    await page.evaluate((trackId) => {
        const instrumented = window as unknown as InstrumentedWindow;
        const initial = instrumented.__navigationPlaybackAudioElements.find(
            (audio) => audio.src.includes(trackId),
        );
        if (!initial) throw new Error("Playback audio element is missing");
        instrumented.__navigationPlaybackPrimaryAudio = initial;
        instrumented.__navigationPlaybackInitialAudioCount =
            instrumented.__navigationPlaybackAudioElements.length;
        instrumented.__navigationPlaybackInitialSrc = initial.src;
        instrumented.__navigationPlaybackEvents = [];
        instrumented.__navigationPlaybackStarted = true;
    }, TEST_TRACK_ID);
}

test("50 real Next transitions preserve one continuously playing audio runtime", async ({
    page,
}, testInfo) => {
    test.setTimeout(180_000);
    const audio = createSyntheticWav();
    const apiRequests: string[] = [];
    const documentRequests: string[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    let streamRequests = 0;

    page.on("request", (request) => {
        if (request.resourceType() === "document") {
            documentRequests.push(request.url());
        }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.addInitScript(
        ({ ownerId, track }) => {
            const instrumented = window as unknown as InstrumentedWindow;
            instrumented.__navigationPlaybackDocumentId = crypto.randomUUID();
            instrumented.__navigationPlaybackAudioElements = [];
            instrumented.__navigationPlaybackEvents = [];
            const originalCreateElement = Document.prototype.createElement;
            Document.prototype.createElement = function createElement(
                localName: string,
                options?: ElementCreationOptions,
            ) {
                const element = originalCreateElement.call(
                    this,
                    localName,
                    options,
                );
                if (localName.toLowerCase() === "audio") {
                    const audio = element as HTMLAudioElement;
                    instrumented.__navigationPlaybackAudioElements.push(audio);
                    for (const type of ["pause", "ended", "emptied"] as const) {
                        audio.addEventListener(type, () => {
                            if (
                                instrumented.__navigationPlaybackStarted &&
                                instrumented.__navigationPlaybackPrimaryAudio ===
                                    audio
                            ) {
                                instrumented.__navigationPlaybackEvents.push({
                                    type,
                                    currentTime: audio.currentTime,
                                });
                            }
                        });
                    }
                }
                return element;
            };

            localStorage.setItem("soundspan_playback_owner_id", ownerId);
            localStorage.setItem(
                "soundspan_current_track",
                JSON.stringify(track),
            );
            localStorage.setItem("soundspan_playback_type", "track");
            localStorage.setItem("soundspan_queue", JSON.stringify([track]));
            localStorage.setItem("soundspan_current_index", "0");
            localStorage.setItem("soundspan_is_shuffle", "false");
            localStorage.setItem("soundspan_is_playing", "false");
            localStorage.setItem("soundspan_current_time", "0");
            localStorage.setItem("soundspan_current_time_track_id", track.id);
            localStorage.setItem("soundspan_muted", "true");
            localStorage.setItem("soundspan_volume", "0");
        },
        { ownerId: TEST_USER_ID, track: TEST_TRACK },
    );

    await page.routeWebSocket("**/socket.io/**", (socket) => {
        socket.onMessage((message) => {
            const text = message.toString();
            if (text === "2") socket.send("3");
            if (text.startsWith("40")) {
                socket.send('40{"sid":"navigation-e2e"}');
            }
        });
        socket.send(
            '0{"sid":"navigation-e2e","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}',
        );
    });

    await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        apiRequests.push(`${request.method()} ${path}`);

        if (path === `/api/library/tracks/${TEST_TRACK_ID}/stream`) {
            streamRequests += 1;
            await fulfillAudioRange(route, audio);
            return;
        }

        let body: unknown = {};
        if (path === "/api/auth/me") {
            body = {
                id: TEST_USER_ID,
                username: "navigation-e2e",
                displayName: "Navigation E2E",
                role: "user",
                onboardingComplete: true,
                createdAt: "2026-09-05T00:00:00.000Z",
            };
        } else if (path === "/api/playback-state") {
            body = request.method() === "GET" ? null : {};
        } else if (path === "/api/taste-profile") {
            body = {
                profile: null,
                completedAt: null,
                skippedAt: "2026-09-05T00:00:00.000Z",
                needsOnboarding: false,
            };
        } else if (path === "/api/playlists") {
            body = [];
        } else if (path === "/api/library/liked") {
            body = {
                playlist: {
                    id: "my-liked",
                    name: "Любимые треки",
                    description: "Isolated E2E response",
                },
                tracks: [],
                total: 0,
                pagination: { limit: 100, hasMore: false, nextCursor: null },
            };
        } else if (path === "/api/library/saved") {
            body = { items: [], total: 0 };
        } else if (path === "/api/import/jobs") {
            body = { jobs: [] };
        } else if (path === "/api/notifications") {
            body = [];
        } else if (path === "/api/system/features") {
            body = {
                musicCNN: false,
                vibeEmbeddings: false,
                audioAnalysis: true,
                discovery: false,
                autoPlaylists: false,
                federation: false,
                vibe: {
                    provider: {
                        configured: false,
                        reachable: null,
                        checkedAt: null,
                        fresh: false,
                    },
                    activeSpace: null,
                    migration: null,
                },
                loudnessTargetLufs: -18,
            };
        } else if (path === "/api/system/ui-settings") {
            body = { showVersion: false };
        }

        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
        });
    });

    await page.goto("/library");
    await expect(page.locator('[data-shell-frame="desktop"]')).toBeVisible();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (
                        window as Window & {
                            __SOUNDSPAN_RUNTIME_CONFIG__?: {
                                STREAMING_ENGINE_MODE?: string;
                            };
                        }
                    ).__SOUNDSPAN_RUNTIME_CONFIG__?.STREAMING_ENGINE_MODE,
            ),
        )
        .toBe("native");

    await expect.poll(() => readAudioSample(page)).not.toBeNull();
    const playButton = page
        .getByRole("button", { name: "Воспроизвести", exact: true })
        .last();
    await expect(playButton).toBeEnabled();
    await playButton.click();
    await expect
        .poll(async () => {
            const sample = await readAudioSample(page);
            return Boolean(
                sample &&
                !sample.paused &&
                !sample.ended &&
                sample.readyState >= 2 &&
                sample.currentTime > 0,
            );
        })
        .toBe(true);

    await lockInitialAudioEvidence(page);
    const initial = await readAudioSample(page);
    expect(initial).not.toBeNull();
    expect(initial!.sameElement).toBe(true);
    expect(initial!.initialElementOccurrences).toBe(1);
    expect(initial!.matchingSourceCount).toBe(1);
    expect(initial!.replacementSourceCount).toBe(0);
    const documentId = initial!.documentId;
    const initialAudioCount = initial!.audioCount;
    const records: Array<{
        index: number;
        path: string;
        currentTime: number;
        readyState: number;
        audioCount: number;
    }> = [];
    let previousTime = initial!.currentTime;

    for (let index = 0; index < NAVIGATION_COUNT; index += 1) {
        const toLiked = index % 2 === 0;
        const targetPath = toLiked ? "/playlist/my-liked" : "/library";
        const link = toLiked
            ? page.locator(
                  '[data-library-view="playlists"] [data-library-static-playlist="liked"]',
              )
            : page.locator(
                  '[data-shell-navigation="primary"] a[href="/library"]',
              );
        await expect(link).toBeVisible();
        await link.click();
        await expect(page).toHaveURL(
            new RegExp(`${targetPath.replaceAll("/", "\\/")}$`),
        );

        const sample = await readAudioSample(page);
        expect(
            sample,
            `audio runtime missing after transition ${index + 1}`,
        ).not.toBeNull();
        expect(sample!.documentId).toBe(documentId);
        expect(sample!.sameElement).toBe(true);
        expect(sample!.audioCount).toBe(initialAudioCount);
        expect(sample!.initialElementOccurrences).toBe(1);
        expect(sample!.matchingSourceCount).toBe(1);
        expect(sample!.replacementSourceCount).toBe(0);
        expect(sample!.paused).toBe(false);
        expect(sample!.ended).toBe(false);
        expect(sample!.currentTime).toBeGreaterThanOrEqual(previousTime - 0.05);
        previousTime = sample!.currentTime;
        records.push({
            index: index + 1,
            path: new URL(page.url()).pathname,
            currentTime: sample!.currentTime,
            readyState: sample!.readyState,
            audioCount: sample!.audioCount,
        });
    }

    await page.waitForTimeout(1_000);
    const final = await readAudioSample(page);
    expect(final).not.toBeNull();
    expect(final!.documentId).toBe(documentId);
    expect(final!.sameElement).toBe(true);
    expect(final!.audioCount).toBe(initialAudioCount);
    expect(final!.initialElementOccurrences).toBe(1);
    expect(final!.matchingSourceCount).toBe(1);
    expect(final!.replacementSourceCount).toBe(0);
    expect(final!.paused).toBe(false);
    expect(final!.ended).toBe(false);
    expect(final!.currentTime).toBeGreaterThan(initial!.currentTime + 1);
    expect(documentRequests).toHaveLength(1);
    expect(streamRequests).toBe(1);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    const playbackEvents = await page.evaluate(
        () =>
            (window as unknown as InstrumentedWindow)
                .__navigationPlaybackEvents,
    );
    expect(playbackEvents).toEqual([]);

    const evidence = {
        engineMode: "native",
        transitions: records.length,
        paths: ["/library", "/playlist/my-liked"],
        documentRequests,
        documentId,
        streamRequests,
        initial,
        final,
        initialAudioCount,
        playbackEvents,
        monotonicToleranceSeconds: 0.05,
        apiBoundary: {
            description:
                "Playwright-isolated JSON API responses and a synthetic 120-second WAV; no user or production data",
            uniqueRequests: [...new Set(apiRequests)].sort(),
        },
        records,
    };
    const evidencePath = testInfo.outputPath("navigation-evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await testInfo.attach("navigation-evidence", {
        path: evidencePath,
        contentType: "application/json",
    });
    await page.screenshot({
        path: testInfo.outputPath("navigation-final.png"),
        fullPage: true,
    });
});
