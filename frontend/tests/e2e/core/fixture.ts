import { expect, test as base, type Page, type Route } from "@playwright/test";
import { CORE_ORIGIN } from "../../../playwright.core.config";
import type {
    TasteProfileWriteRequest,
    TasteProfileState,
} from "../../../features/taste-profile/types";
import {
    createSyntheticWav,
    fulfillAudioRange,
} from "../fixtures/syntheticAudio";

/** Synthetic, public-free tracks; no real account or upstream catalog is used. */
export const TRACKS = Array.from({ length: 40 }, (_, index) => ({
    id: `core-track-${String(index + 1).padStart(2, "0")}`,
    title: `Тестовый трек ${String(index + 1).padStart(2, "0")}`,
    artist: {
        id: `core-artist-${index + 1}`,
        name: `Тестовый артист ${String(index + 1).padStart(2, "0")}`,
    },
    album: { id: "core-album", title: "Тестовый альбом", coverArt: null },
    duration: 45,
    filePath: "synthetic/core.wav",
    source: "library" as const,
    streamSource: "library" as const,
    trackNo: null,
    provider: { tidalTrackId: null, youtubeVideoId: null },
}));

const AUDIO = createSyntheticWav(45);
const USER = {
    id: "core-user",
    username: "core-user",
    displayName: "Core QA",
    role: "user",
    onboardingComplete: true,
    createdAt: "2026-01-01T00:00:00.000Z",
};

interface CoreApp {
    authenticated: boolean;
    artists: string[];
    taste: TasteProfileState;
    tasteWrites: TasteProfileWriteRequest[];
    failTasteSaves: number;
    requests: Array<{ method: string; path: string; search: string }>;
    offlineStreamRequests: number;
    setOffline(): Promise<void>;
}

/** Per-context API state. Unknown endpoints and external requests fail the test. */
export const test = base.extend<{ app: CoreApp }>({
    app: [
        async ({ context }, use) => {
            const unexpected: string[] = [];
            let offline = false;
            const app: CoreApp = {
                authenticated: false,
                artists: TRACKS.map((track) => track.artist.name),
                taste: {
                    profile: null,
                    completedAt: null,
                    skippedAt: "2026-01-01T00:00:00.000Z",
                    needsOnboarding: false,
                },
                tasteWrites: [],
                failTasteSaves: 0,
                requests: [],
                offlineStreamRequests: 0,
                async setOffline() {
                    offline = true;
                    await context.setOffline(true);
                },
            };
            await context.addInitScript(() => {
                const captured = window as Window & {
                    __coreAudio?: HTMLAudioElement[];
                };
                captured.__coreAudio = [];
                const create = Document.prototype.createElement;
                Document.prototype.createElement = function (
                    ...args: Parameters<typeof create>
                ) {
                    const element = create.apply(this, args);
                    if (element instanceof HTMLAudioElement)
                        captured.__coreAudio!.push(element);
                    return element;
                };
                localStorage.setItem("soundspan_muted", "true");
                localStorage.setItem("soundspan_volume", "0");
            });
            await context.routeWebSocket("**/*", (socket) => {
                const socketUrl = new URL(socket.url());
                if (
                    socketUrl.host !== new URL(CORE_ORIGIN).host ||
                    socketUrl.pathname !== "/socket.io/listen-together/"
                ) {
                    unexpected.push(
                        `Unmodeled WebSocket ${socketUrl.host}${socketUrl.pathname}`,
                    );
                    socket.close();
                    return;
                }
                socket.send(
                    '0{"sid":"core","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}',
                );
                socket.onMessage((message) => {
                    if (message === "2") socket.send("3");
                    if (typeof message === "string" && message.startsWith("40"))
                        socket.send('40{"sid":"core"}');
                });
            });
            await context.route("**/*", async (route: Route) => {
                const request = route.request();
                const url = new URL(request.url());
                const path = url.pathname;
                const method = request.method();
                if (url.origin !== CORE_ORIGIN) {
                    unexpected.push(`External ${method} ${url.origin}${path}`);
                    await route.abort("blockedbyclient");
                    return;
                }
                if (!path.startsWith("/api/")) {
                    await route.continue();
                    return;
                }
                app.requests.push({ method, path, search: url.search });
                const key = `${method} ${path}`;
                const authenticated =
                    app.authenticated &&
                    request.headers().authorization ===
                        "Bearer core-regression-token";
                const publicEndpoints = [
                    "GET /api/auth/config",
                    "GET /api/onboarding/status",
                    "POST /api/auth/login",
                    "GET /api/system/ui-settings",
                    "GET /api/library/recently-listened",
                ];
                const json = async (body: unknown, status = 200) => {
                    if (offline) return route.abort("internetdisconnected");
                    if (!publicEndpoints.includes(key) && !authenticated) {
                        return route.fulfill({
                            status: 401,
                            contentType: "application/json",
                            body: JSON.stringify({ error: "Unauthorized" }),
                        });
                    }
                    return route.fulfill({
                        status,
                        contentType: "application/json",
                        body: JSON.stringify(body),
                    });
                };
                if (key === "GET /api/auth/config")
                    return json({
                        localLoginEnabled: true,
                        oidcEnabled: false,
                        oidcProviderName: "",
                    });
                if (key === "GET /api/onboarding/status")
                    return json({ needsOnboarding: false, hasAccount: true });
                if (key === "POST /api/auth/login") {
                    const input = request.postDataJSON();
                    if (
                        input.username !== "core-user" ||
                        input.password !== "core-fixture-password"
                    )
                        return json({ error: "Invalid credentials" }, 401);
                    app.authenticated = true;
                    return json({
                        token: "core-regression-token",
                        refreshToken: "core-regression-refresh",
                        user: USER,
                    });
                }
                if (key === "GET /api/auth/me") return json(USER);
                if (key === "GET /api/auth/2fa/status")
                    return json({ enabled: false });
                if (key === "POST /api/auth/logout") {
                    if (authenticated && !offline) app.authenticated = false;
                    return json({ success: true });
                }
                if (key === "GET /api/taste-profile") return json(app.taste);
                if (key === "GET /api/taste-profile/artist-image")
                    return json({ image: null });
                if (key === "GET /api/taste-profile/artists") {
                    const page = Number(url.searchParams.get("page") ?? 1);
                    return json({
                        artists: app.artists.slice((page - 1) * 20, page * 20),
                        nextPage: page === 1 ? 2 : null,
                    });
                }
                if (
                    key === "PUT /api/taste-profile" ||
                    key === "POST /api/taste-profile"
                ) {
                    if (!authenticated || offline) return json(null);
                    const selection =
                        request.postDataJSON() as TasteProfileWriteRequest;
                    app.tasteWrites.push(selection);
                    if (app.failTasteSaves > 0) {
                        app.failTasteSaves -= 1;
                        return json({ error: "Fixture save failed" }, 500);
                    }
                    if ("skip" in selection) {
                        app.taste = {
                            profile: null,
                            completedAt: null,
                            skippedAt: "2026-01-01T00:00:00.000Z",
                            needsOnboarding: false,
                        };
                        return json(app.taste);
                    }
                    app.taste = {
                        profile: { ...selection, seedTracks: [] },
                        completedAt: "2026-01-01T00:00:00.000Z",
                        skippedAt: null,
                        needsOnboarding: false,
                    };
                    return json(app.taste);
                }
                if (key === "GET /api/personalized/home") {
                    const tuned =
                        url.searchParams.get("surface") === "wave" &&
                        url.searchParams.get("mode") === "new" &&
                        url.searchParams.get("mood") === "calm";
                    const tracks = tuned
                        ? TRACKS.slice(10, 20)
                        : TRACKS.slice(0, 20);
                    return json({
                        generationId: tuned
                            ? "core-tuned-wave"
                            : "core-generation",
                        shelves: {
                            quickPicks: tracks,
                            discovery: tracks,
                            listenAgain: tuned ? [] : TRACKS.slice(20),
                        },
                        degraded: false,
                        reason: null,
                        seedCount: 3,
                    });
                }
                if (key === "GET /api/personalized/daily-mixes")
                    return json({
                        mixes: [
                            {
                                key: "core-mix-a",
                                title: "Тестовый микс A",
                                description: "",
                                tracks: TRACKS.slice(0, 20),
                            },
                            {
                                key: "core-mix-b",
                                title: "Тестовый микс B",
                                description: "",
                                tracks: TRACKS.slice(20),
                            },
                        ],
                    });
                if (
                    method === "GET" &&
                    /^\/api\/library\/tracks\/core-track-\d{2}\/stream$/.test(
                        path,
                    )
                ) {
                    if (offline) {
                        app.offlineStreamRequests += 1;
                        return route.abort("internetdisconnected");
                    }
                    const hasMediaCookie = (request.headers().cookie ?? "")
                        .split(";")
                        .some(
                            (cookie) =>
                                cookie.trim() ===
                                "soundspan_media_auth=core-regression-token",
                        );
                    if (
                        !app.authenticated ||
                        (!authenticated && !hasMediaCookie)
                    )
                        return json(null, 401);
                    return fulfillAudioRange(route, AUDIO);
                }
                if (key === "GET /api/playback-state") return json(null);
                if (key === "GET /api/ytmusic/status")
                    return json({
                        enabled: false,
                        available: false,
                        authenticated: false,
                        credentialsConfigured: false,
                    });
                if (key === "POST /api/ytmusic/tail-warmup/reconcile") {
                    const input = request.postDataJSON();
                    return json({
                        ownerId: input.ownerId,
                        generation: input.generation,
                        accepted: true,
                        items: [],
                    });
                }
                if (key === "GET /api/listen-together/mine") return json(null);
                if (key === "GET /api/mixes") return json([]);
                if (key === "GET /api/discover/current")
                    return json({
                        weekStart: "2026-01-01",
                        weekEnd: "2026-01-08",
                        tracks: [],
                        unavailable: [],
                        totalCount: 0,
                        unavailableCount: 0,
                    });
                if (key === "POST /api/social/presence/heartbeat")
                    return json({ success: true });
                if (key === "POST /api/personalized/impressions")
                    return json({
                        recorded: request.postDataJSON().tracks.length,
                    });
                if (key === "POST /api/plays") return json({ id: "core-play" });
                if (key === "PATCH /api/plays/core-play/engagement")
                    return json({ success: true });
                if (
                    method === "GET" &&
                    /^\/api\/library\/tracks\/core-track-\d{2}\/preference$/.test(
                        path,
                    )
                )
                    return json({
                        signal: null,
                        liked: false,
                        disliked: false,
                    });
                if (
                    method === "GET" &&
                    /^\/api\/lyrics\/core-track-\d{2}$/.test(path)
                )
                    return json({
                        syncedLyrics: null,
                        plainLyrics: null,
                        source: "none",
                        synced: false,
                    });
                if (key === "POST /api/streaming/v1/client-metrics")
                    return json({ success: true });
                if (
                    [
                        "PUT /api/playback-state",
                        "POST /api/playback-state",
                        "POST /api/listening-state",
                        "POST /api/library/listen",
                    ].includes(key)
                )
                    return json({ success: true });
                if (
                    ["GET /api/playlists", "GET /api/notifications"].includes(
                        key,
                    )
                )
                    return json([]);
                if (
                    [
                        "GET /api/library/recently-listened",
                        "GET /api/library/recently-added",
                        "GET /api/library/saved",
                    ].includes(key)
                )
                    return json({ items: [], total: 0 });
                if (key === "GET /api/library/liked")
                    return json({
                        playlist: { id: "my-liked", name: "Любимые треки" },
                        tracks: [],
                        total: 0,
                        pagination: {
                            limit: 100,
                            hasMore: false,
                            nextCursor: null,
                        },
                    });
                if (key === "GET /api/import/jobs") return json({ jobs: [] });
                if (key === "GET /api/system/ui-settings")
                    return json({ showVersion: false });
                if (key === "GET /api/system/features")
                    return json({
                        musicCNN: false,
                        vibeEmbeddings: false,
                        audioAnalysis: true,
                        discovery: false,
                        autoPlaylists: false,
                        federation: false,
                        loudnessTargetLufs: -18,
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
                    });
                if (key === "GET /api/settings") return json({});
                unexpected.push(key);
                await route.abort("blockedbyclient");
            });
            await use(app);
            expect(
                unexpected,
                "Unmodeled requests must not silently pass or reach a real service",
            ).toEqual([]);
        },
        { auto: true },
    ],
});

/** Log in through the actual local-login form with synthetic credentials. */
export async function login(page: Page): Promise<void> {
    await page.goto("/login");
    await page.locator("#username").fill("core-user");
    await page.locator("#password").fill("core-fixture-password");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(
        page.locator('[data-home-layout="personal-dashboard"]'),
    ).toBeVisible();
}

/** Inspect the real HTMLAudioElement; never mock playback or its clock. */
export async function readAudio(page: Page, source: string) {
    return page.evaluate((match) => {
        const elements =
            (window as Window & { __coreAudio?: HTMLAudioElement[] })
                .__coreAudio ?? [];
        const candidates = elements.filter((audio) =>
            audio.src.includes(match),
        );
        const audio =
            candidates.find((element) => !element.paused) ?? candidates.at(-1);
        return audio
            ? {
                  time: audio.currentTime,
                  paused: audio.paused,
                  src: audio.src,
                  readyState: audio.readyState,
              }
            : null;
    }, source);
}

/** A playing flag alone is insufficient: actual decoded media time must advance. */
export async function expectPlaying(
    page: Page,
    source: string,
    since = 0,
    timeout = 12_000,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const audio = await readAudio(page, source);
                return Boolean(audio && !audio.paused && audio.readyState >= 2);
            },
            { timeout, message: `Decoded media is ready for ${source}` },
        )
        .toBe(true);
    const baseline = Math.max(since, (await readAudio(page, source))!.time);
    await expect
        .poll(
            async () => {
                const audio = await readAudio(page, source);
                return Boolean(
                    audio &&
                    !audio.paused &&
                    audio.readyState >= 2 &&
                    audio.time > baseline + 0.15,
                );
            },
            { timeout, message: `Real media advances for ${source}` },
        )
        .toBe(true);
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const elements =
                        (
                            window as Window & {
                                __coreAudio?: HTMLAudioElement[];
                            }
                        ).__coreAudio ?? [];
                    return elements.filter(
                        (audio) =>
                            !audio.paused && !audio.ended && Boolean(audio.src),
                    ).length;
                }),
            { message: "Only one media runtime may play" },
        )
        .toBe(1);
}
