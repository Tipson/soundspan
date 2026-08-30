import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const calls = {
    downloads: [] as Array<Record<string, unknown>>,
    deletes: [] as string[],
    queueCancels: [] as string[],
    resumes: [] as string[],
    prepares: [] as string[],
    exports: [] as string[],
    plays: [] as string[],
    settingUpdates: [] as Array<Record<string, unknown>>,
    collectionEnqueues: [] as Array<Record<string, unknown>>,
    storageRetries: 0,
    storageSetups: 0,
    confirmations: [] as string[],
};
let collectionStatus = {
    total: 2,
    ready: 0,
    autoReady: 0,
    queued: 0,
    processing: 0,
    errors: 0,
};

let records: Array<Record<string, unknown>> = [];
let trackRecord: Record<string, unknown> | null = null;
let resumeFailure: Error | null = null;
let deleteFailure: Error | null = null;
let prepareFailure: Error | null = null;
let isHydrated = true;
let storageError: string | null = null;
let storage: {
    status:
        | "checking"
        | "needs-setup"
        | "requesting"
        | "ready"
        | "unsupported"
        | "error";
    directoryName: string | null;
    explanation: string;
    storageKind?: "desktop-directory" | "browser-private" | null;
} = {
    status: "ready" as
        | "checking"
        | "needs-setup"
        | "requesting"
        | "ready"
        | "unsupported"
        | "error",
    directoryName: "Soundspan Music" as string | null,
    explanation: "Downloads are saved in the selected device folder.",
};
let confirmDelete = true;
const offlineContext = {
    get isHydrated() {
        return isHydrated;
    },
    isQueueHydrated: true,
    get storageError() {
        return storageError;
    },
    get storage() {
        return storage;
    },
    get records() {
        return records;
    },
    capability: { mode: "foreground", explanation: "Keep soundspan open." },
    download: async (input: Record<string, unknown>) => {
        calls.downloads.push(input);
        return { status: "ready" };
    },
    resume: async (record: { key: string }) => {
        calls.resumes.push(record.key);
        if (resumeFailure) throw resumeFailure;
    },
    deleteDownload: async (key: string) => {
        calls.deletes.push(key);
        if (deleteFailure) throw deleteFailure;
    },
    cancelQueuedDownload: async (item: { key: string }) => {
        calls.queueCancels.push(item.key);
        if (deleteFailure) throw deleteFailure;
    },
    preparePlayback: async (record: { key: string }) => {
        calls.prepares.push(record.key);
        if (prepareFailure) throw prepareFailure;
    },
    exportDownload: async (record: { key: string }) => {
        calls.exports.push(record.key);
        return "Artist - Alpha.mp3";
    },
    get recordForTrack() {
        return () => trackRecord;
    },
    queueItems: [] as Array<Record<string, unknown>>,
    automationSettings: {
        ownerId: "user-1",
        autoDownloadLiked: false,
        autoDownloadLikedLimit: 100,
        autoDownloadMaxBytes: 2 * 1024 * 1024 * 1024,
        updatedAt: 0,
    },
    enqueueCollection: async (input: Record<string, unknown>) => {
        calls.collectionEnqueues.push(input);
        return { total: 2, queued: 2, alreadyReady: 0 };
    },
    collectionStatus: () => collectionStatus,
    updateAutomationSettings: async (patch: Record<string, unknown>) => {
        calls.settingUpdates.push(patch);
        Object.assign(offlineContext.automationSettings, patch);
    },
    refresh: async () => undefined,
    retryStorage: async () => {
        calls.storageRetries += 1;
    },
    setupStorage: async () => {
        calls.storageSetups += 1;
        return storage;
    },
};

const Icon = () => React.createElement("svg");
mock.module("lucide-react", {
    namedExports: {
        Music: Icon,
        Play: Icon,
        Radio: Icon,
        HardDriveDownload: Icon,
        RotateCcw: Icon,
        Trash2: Icon,
        EllipsisVertical: Icon,
        Link: Icon,
        ListEnd: Icon,
        ListPlus: Icon,
        Map: Icon,
        Plus: Icon,
        Share2: Icon,
        User: Icon,
        Disc3: Icon,
        AudioWaveform: Icon,
        ChevronDown: Icon,
        ChevronLeft: Icon,
        ChevronRight: Icon,
        Download: Icon,
        Check: Icon,
        AlertTriangle: Icon,
        Loader2: Icon,
    },
});
mock.module("next/image", {
    defaultExport: ({ alt, src }: { alt?: string; src?: string }) =>
        React.createElement("img", { alt, src }),
});
mock.module("sonner", {
    exports: {
        toast: {
            success() {},
            error() {},
        },
    },
});
mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push() {} }) },
});
mock.module("@/components/ui/PlaylistSelector", {
    namedExports: { PlaylistSelector: () => null },
});
mock.module("@/components/ui/ShareLinkModal", {
    namedExports: { ShareLinkModal: () => null },
});
mock.module("@/lib/trackRef", {
    namedExports: {
        isRemoteTrack: () => false,
        toAddToPlaylistRef: () => ({ source: "local", trackId: "track" }),
    },
});
mock.module("@/lib/shareLinks", {
    namedExports: { canShareTrack: () => false },
});
mock.module("@/utils/artistRoute", {
    namedExports: { getArtistHref: () => null },
});
mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YT"),
    },
});
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: {
        useOptionalDeviceOffline: () => offlineContext,
        useDeviceOffline: () => offlineContext,
    },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks() {},
            playNow: (track: { id: string }) => calls.plays.push(track.id),
            playNext() {},
            addToQueue() {},
            playTrack() {},
            startVibeMode: async () => ({ success: false, trackCount: 0 }),
        }),
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            getYtMusicStreamUrl: (
                id: string,
                _quality?: string,
                usePublic?: boolean,
            ) => `/api/ytmusic/${usePublic ? "stream-public" : "stream"}/${id}`,
            getTidalStreamUrl: (id: number) =>
                `/api/tidal-streaming/stream/${id}`,
            getYouTubeStreamUrl: (id: string) => `/api/youtube/stream/${id}`,
            getStreamUrl: (id: string) => `/api/library/tracks/${id}/stream`,
            addTrackToPlaylist: async () => undefined,
        },
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
    records = [];
    trackRecord = null;
    calls.downloads.length = 0;
    calls.deletes.length = 0;
    calls.queueCancels.length = 0;
    calls.resumes.length = 0;
    calls.prepares.length = 0;
    calls.exports.length = 0;
    calls.plays.length = 0;
    calls.settingUpdates.length = 0;
    calls.collectionEnqueues.length = 0;
    calls.storageRetries = 0;
    calls.storageSetups = 0;
    calls.confirmations.length = 0;
    collectionStatus = {
        total: 2,
        ready: 0,
        autoReady: 0,
        queued: 0,
        processing: 0,
        errors: 0,
    };
    offlineContext.automationSettings.autoDownloadLiked = false;
    offlineContext.automationSettings.autoDownloadLikedLimit = 100;
    offlineContext.queueItems.length = 0;
    resumeFailure = null;
    deleteFailure = null;
    prepareFailure = null;
    isHydrated = true;
    storageError = null;
    storage = {
        status: "ready",
        directoryName: "Soundspan Music",
        explanation: "Downloads are saved in the selected device folder.",
    };
    confirmDelete = true;
    Object.defineProperty(window, "confirm", {
        configurable: true,
        value: (message: string) => {
            calls.confirmations.push(message);
            return confirmDelete;
        },
    });
});

test("storage failures stay visible in Downloads and ordinary Settings with retry", async () => {
    isHydrated = false;
    storageError = "Could not read device storage.";
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const { DeviceOfflineSettingsSection } =
        await import("../../features/settings/components/sections/DeviceOfflineSettingsSection");

    const downloads = await render(React.createElement(DownloadsList));
    assert.match(
        downloads.container.textContent ?? "",
        /Could not read device storage/i,
    );
    assert.doesNotMatch(
        downloads.container.textContent ?? "",
        /No device downloads/i,
    );
    const downloadsRetry = downloads.container.querySelector(
        'button[aria-label="Повторить чтение загрузок на этом устройстве"]',
    ) as HTMLButtonElement;
    assert.match(downloadsRetry.className, /min-h-11/);
    await React.act(async () => downloadsRetry.click());

    const settings = await render(
        React.createElement(DeviceOfflineSettingsSection),
    );
    assert.match(
        settings.container.textContent ?? "",
        /Could not read device storage/i,
    );
    assert.match(settings.container.textContent ?? "", /Retry/i);
    assert.equal(
        (
            settings.container.querySelector(
                "#device-auto-download-liked",
            ) as HTMLInputElement
        ).disabled,
        true,
    );
    assert.equal(calls.storageRetries, 1);
    downloads.unmount();
    settings.unmount();
});

test("Downloads UI exposes queued device-local work without marking it playable", async () => {
    offlineContext.queueItems.push({
        key: "queued-key",
        ownerId: "user-1",
        trackIdentity: "youtube:video-a",
        quality: "auto",
        track,
        sourceUrl: "/api/ytmusic/stream-public/video-a",
        management: "manual",
        collectionId: "album:one",
        collectionLabel: "Album One",
        status: "queued",
        attempt: 0,
        leaseId: null,
        leaseExpiresAt: null,
        createdAt: 1,
        updatedAt: 1,
        errorMessage: null,
    });
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    assert.match(view.container.textContent ?? "", /В очереди на этом устройстве/i);
    assert.doesNotMatch(
        view.container.textContent ?? "",
        /No device downloads/i,
    );
    assert.equal(
        view.container.querySelector('button[aria-label="Воспроизвести: Alpha"]'),
        null,
    );
    const remove = view.container.querySelector(
        'button[aria-label="Удалить с этого устройства: Alpha"]',
    ) as HTMLButtonElement;
    assert.match(remove.className, /h-11 w-11/);
    await React.act(async () => remove.click());
    assert.deepEqual(calls.queueCancels, ["queued-key"]);
    assert.match(calls.confirmations[0], /только с этого устройства/i);
    view.unmount();
});

test("empty Downloads asks for a real device folder instead of presenting browser cache as storage", async () => {
    storage = {
        status: "needs-setup",
        directoryName: null,
        explanation:
            "Choose a folder so music is stored as files on this device.",
    };
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    assert.match(view.container.textContent ?? "", /Выбрать папку с музыкой/i);
    assert.doesNotMatch(
        view.container.textContent ?? "",
        /No device downloads|browser storage/i,
    );
    const setup = view.container.querySelector(
        'button[aria-label="Выбрать папку с музыкой"]',
    ) as HTMLButtonElement;
    await React.act(async () => {
        setup.click();
        await Promise.resolve();
    });
    assert.equal(calls.storageSetups, 1);
    view.unmount();
});

test("Downloads reconnects a remembered folder without offering a destructive folder change", async () => {
    storage = {
        status: "error",
        directoryName: "Soundspan Music",
        explanation: "Allow Soundspan to use the remembered folder again.",
    };
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    assert.match(view.container.textContent ?? "", /Подключить папку с музыкой заново/i);
    assert.equal(
        view.container.querySelector(
            'button[aria-label="Выбрать папку с музыкой"]',
        ),
        null,
    );
    const reconnect = view.container.querySelector(
        'button[aria-label="Подключить папку с музыкой заново"]',
    ) as HTMLButtonElement;
    assert.ok(reconnect);
    await React.act(async () => {
        reconnect.click();
        await Promise.resolve();
    });
    assert.equal(calls.storageSetups, 1);
    view.unmount();
});

test("album device action batches playable tracks and exposes truthful collection states", async () => {
    const { DeviceCollectionDownloadButton } =
        await import("../../features/device-offline/components/DeviceCollectionDownloadButton");
    const tracks = [
        {
            id: "yt:video-a",
            title: "Alpha",
            duration: 201,
            artist: { name: "Artist A" },
            album: { title: "Album" },
            streamSource: "youtube" as const,
            youtubeVideoId: "video-a",
        },
        {
            id: "yt:video-b",
            title: "Beta",
            duration: 202,
            artist: { name: "Artist A" },
            album: { title: "Album" },
            streamSource: "youtube" as const,
            youtubeVideoId: "video-b",
        },
    ];
    const view = await render(
        React.createElement(DeviceCollectionDownloadButton, {
            tracks,
            collectionId: "album:one",
            collectionLabel: "Album One",
        }),
    );
    const button = view.container.querySelector("button") as HTMLButtonElement;
    assert.equal(
        button.getAttribute("aria-label"),
        "Скачать Album One на это устройство",
    );
    assert.match(button.className, /min-h-11/);
    await React.act(async () => {
        button.click();
        await Promise.resolve();
    });
    assert.equal(calls.collectionEnqueues.length, 1);
    assert.equal((calls.collectionEnqueues[0].tracks as unknown[]).length, 2);

    collectionStatus = {
        total: 2,
        ready: 1,
        autoReady: 0,
        queued: 0,
        processing: 0,
        errors: 1,
    };
    const failed = await render(
        React.createElement(DeviceCollectionDownloadButton, {
            tracks,
            collectionId: "album:one",
            collectionLabel: "Album One",
        }),
    );
    assert.match(failed.container.textContent ?? "", /Повторить: 1 ошибка/i);
    collectionStatus = {
        total: 2,
        ready: 2,
        autoReady: 1,
        queued: 0,
        processing: 0,
        errors: 0,
    };
    const protect = await render(
        React.createElement(DeviceCollectionDownloadButton, {
            tracks,
            collectionId: "album:one",
            collectionLabel: "Album One",
        }),
    );
    const protectButton = protect.container.querySelector(
        "button",
    ) as HTMLButtonElement;
    assert.match(protectButton.textContent ?? "", /Хранить офлайн/i);
    assert.equal(protectButton.disabled, false);
    await React.act(async () => {
        protectButton.click();
        await Promise.resolve();
    });
    assert.equal(calls.collectionEnqueues.length, 2);
    view.unmount();
    failed.unmount();
    protect.unmount();
});

test("ordinary settings expose an opt-in auto-liked policy for this device only", async () => {
    const { DeviceOfflineSettingsSection } =
        await import("../../features/settings/components/sections/DeviceOfflineSettingsSection");
    const view = await render(
        React.createElement(DeviceOfflineSettingsSection),
    );
    assert.match(view.container.textContent ?? "", /Офлайн на этом устройстве/i);
    assert.match(
        view.container.textContent ?? "",
        /Автоматически скачивать любимые треки на это устройство/i,
    );
    assert.match(view.container.textContent ?? "", /2 ГБ/i);
    assert.match(view.container.textContent ?? "", /Soundspan Music/i);
    assert.doesNotMatch(view.container.textContent ?? "", /browser storage/i);
    const toggle = view.container.querySelector(
        "#device-auto-download-liked",
    ) as HTMLInputElement;
    assert.equal(toggle.checked, false);
    assert.match(toggle.parentElement?.className ?? "", /min-h-11/);

    await React.act(async () => {
        toggle.click();
        await Promise.resolve();
    });
    assert.deepEqual(calls.settingUpdates, [{ autoDownloadLiked: true }]);
    view.unmount();
});

test("offline settings require an explicit device folder before enabling automatic downloads", async () => {
    storage = {
        status: "needs-setup",
        directoryName: null,
        explanation:
            "Choose a folder so music is stored as files on this device.",
    };
    const { DeviceOfflineSettingsSection } =
        await import("../../features/settings/components/sections/DeviceOfflineSettingsSection");
    const view = await render(
        React.createElement(DeviceOfflineSettingsSection),
    );

    assert.match(view.container.textContent ?? "", /Выбрать папку с музыкой/i);
    const toggle = view.container.querySelector(
        "#device-auto-download-liked",
    ) as HTMLInputElement;
    assert.equal(toggle.disabled, true);
    const setup = view.container.querySelector(
        'button[aria-label="Выбрать папку с музыкой"]',
    ) as HTMLButtonElement;
    await React.act(async () => {
        setup.click();
        await Promise.resolve();
    });
    assert.equal(calls.storageSetups, 1);
    assert.deepEqual(calls.settingUpdates, []);
    view.unmount();
});

test("offline settings reconnect a remembered folder instead of claiming to choose a new one", async () => {
    storage = {
        status: "error",
        directoryName: "Soundspan Music",
        explanation: "Allow Soundspan to use the remembered folder again.",
    };
    const { DeviceOfflineSettingsSection } =
        await import("../../features/settings/components/sections/DeviceOfflineSettingsSection");
    const view = await render(
        React.createElement(DeviceOfflineSettingsSection),
    );

    assert.match(view.container.textContent ?? "", /Подключить папку заново/i);
    assert.equal(
        view.container.querySelector(
            'button[aria-label="Выбрать папку с музыкой"]',
        ),
        null,
    );
    const reconnect = view.container.querySelector(
        'button[aria-label="Подключить папку с музыкой заново"]',
    ) as HTMLButtonElement;
    assert.ok(reconnect);
    await React.act(async () => {
        reconnect.click();
        await Promise.resolve();
    });
    assert.equal(calls.storageSetups, 1);
    view.unmount();
});

test("unsupported browsers explain that a plain PWA cannot save managed files outside browser-private storage", async () => {
    storage = {
        status: "unsupported",
        directoryName: null,
        explanation:
            "Firefox and Safari PWAs cannot save a managed music library into a normal device folder. Use Chrome or Edge on desktop, or the installed Soundspan mobile app.",
    };
    const { DeviceOfflineSettingsSection } =
        await import("../../features/settings/components/sections/DeviceOfflineSettingsSection");
    const view = await render(
        React.createElement(DeviceOfflineSettingsSection),
    );

    assert.match(view.container.textContent ?? "", /Firefox and Safari PWAs/i);
    assert.match(view.container.textContent ?? "", /normal device folder/i);
    assert.equal(
        view.container.querySelector(
            'button[aria-label="Выбрать папку с музыкой"]',
        ),
        null,
    );
    assert.equal(
        (
            view.container.querySelector(
                "#device-auto-download-liked",
            ) as HTMLInputElement
        ).disabled,
        true,
    );
    view.unmount();
});

async function render(element: React.ReactElement) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(element));
    return {
        container,
        unmount() {
            void React.act(() => root.unmount());
            container.remove();
        },
    };
}

const track = {
    id: "yt:video-a",
    title: "Alpha",
    duration: 201,
    trackNo: null,
    artist: { id: null, name: "Artist A" },
    album: { id: null, title: "Single", coverArt: null },
    source: "youtube" as const,
    provider: { tidalTrackId: null, youtubeVideoId: "video-a" },
    streamSource: "youtube" as const,
    youtubeVideoId: "video-a",
};
const overflowTrack = {
    id: track.id,
    title: track.title,
    duration: track.duration,
    artist: { name: track.artist.name },
    album: { title: track.album.title },
    streamSource: track.streamSource,
    youtubeVideoId: track.youtubeVideoId,
};

test("personalized discovery exposes a real clean device-download action", async () => {
    const { PersonalizedTrackShelf } =
        await import("../../features/home/components/PersonalizedTrackShelf");
    const view = await render(
        React.createElement(PersonalizedTrackShelf, {
            title: "Quick picks",
            tracks: [track],
        }),
    );
    const button = view.container.querySelector(
        'button[aria-label="Download Alpha to this device"]',
    ) as HTMLButtonElement | null;
    assert.ok(button);
    assert.match(button.className, /min-h-11/);
    assert.match(button.className, /min-w-11/);
    const playAll = view.container.querySelector(
        'button[aria-label="Play all Quick picks"]',
    ) as HTMLButtonElement;
    assert.match(playAll.className, /min-h-11/);
    await React.act(async () => button.click());
    assert.equal(calls.downloads.length, 1);
    assert.equal(
        calls.downloads[0].sourceUrl,
        "/api/ytmusic/stream-public/video-a",
    );
    assert.doesNotMatch(String(calls.downloads[0].sourceUrl), /token=/);
    view.unmount();
});

test("single-track actions explain unavailable storage without blocking folder setup", async () => {
    const { PersonalizedTrackShelf } =
        await import("../../features/home/components/PersonalizedTrackShelf");
    const { TrackOverflowMenu } =
        await import("../../components/ui/TrackOverflowMenu");

    for (const unavailable of [
        {
            status: "unsupported" as const,
            label: "Device downloads are unavailable in this browser",
        },
        {
            status: "checking" as const,
            label: "Checking device storage for Alpha",
        },
        {
            status: "requesting" as const,
            label: "Waiting for folder access for Alpha",
        },
    ]) {
        storage = {
            status: unavailable.status,
            directoryName: null,
            explanation: "Storage is not ready.",
        };
        const shelf = await render(
            React.createElement(PersonalizedTrackShelf, {
                title: "Quick picks",
                tracks: [track],
            }),
        );
        const shelfAction = shelf.container.querySelector(
            `button[aria-label="${unavailable.label}"]`,
        ) as HTMLButtonElement;
        assert.ok(shelfAction);
        assert.equal(shelfAction.disabled, true);
        shelf.unmount();
    }

    storage = {
        status: "unsupported",
        directoryName: null,
        explanation: "Storage is not supported.",
    };
    const menu = await render(
        React.createElement(TrackOverflowMenu, { track: overflowTrack }),
    );
    await React.act(async () =>
        (
            menu.container.querySelector(
                'button[aria-label="Track actions"]',
            ) as HTMLButtonElement
        ).click(),
    );
    const unsupportedMenuAction = [
        ...menu.container.querySelectorAll("button"),
    ].find((button) =>
        button.textContent?.includes("Downloads unavailable in this browser"),
    );
    assert.ok(unsupportedMenuAction);
    assert.equal((unsupportedMenuAction as HTMLButtonElement).disabled, true);
    menu.unmount();

    for (const actionable of ["needs-setup", "error"] as const) {
        storage = {
            status: actionable,
            directoryName: actionable === "error" ? "Soundspan Music" : null,
            explanation: "Folder access is required.",
        };
        const shelf = await render(
            React.createElement(PersonalizedTrackShelf, {
                title: "Quick picks",
                tracks: [track],
            }),
        );
        const action = shelf.container.querySelector(
            actionable === "error"
                ? 'button[aria-label="Reconnect folder to download Alpha"]'
                : 'button[aria-label="Choose a folder to download Alpha"]',
        ) as HTMLButtonElement;
        assert.ok(action);
        assert.equal(action.disabled, false);
        await React.act(async () => action.click());
        shelf.unmount();
    }
    assert.equal(calls.downloads.length, 2);
});

test("single-track actions can protect an automatic ready copy", async () => {
    trackRecord = {
        key: "auto-ready",
        status: "ready",
        management: "auto-liked",
    };
    const { PersonalizedTrackShelf } =
        await import("../../features/home/components/PersonalizedTrackShelf");
    const { TrackOverflowMenu } =
        await import("../../components/ui/TrackOverflowMenu");

    const shelf = await render(
        React.createElement(PersonalizedTrackShelf, {
            title: "Quick picks",
            tracks: [track],
        }),
    );
    const shelfAction = shelf.container.querySelector(
        'button[aria-label="Keep Alpha offline on this device"]',
    ) as HTMLButtonElement;
    assert.ok(shelfAction);
    assert.equal(shelfAction.disabled, false);
    await React.act(async () => shelfAction.click());
    shelf.unmount();

    const menu = await render(
        React.createElement(TrackOverflowMenu, { track: overflowTrack }),
    );
    await React.act(async () =>
        (
            menu.container.querySelector(
                'button[aria-label="Track actions"]',
            ) as HTMLButtonElement
        ).click(),
    );
    const keep = [...menu.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Keep offline on this device"),
    ) as HTMLButtonElement;
    assert.ok(keep);
    assert.equal(keep.disabled, false);
    await React.act(async () => keep.click());
    assert.equal(calls.downloads.length, 2);
    menu.unmount();

    storage = {
        status: "checking",
        directoryName: "Soundspan Music",
        explanation: "Checking the remembered folder.",
    };
    const checking = await render(
        React.createElement(PersonalizedTrackShelf, {
            title: "Quick picks",
            tracks: [track],
        }),
    );
    const checkingAction = checking.container.querySelector(
        'button[aria-label="Checking device storage for Alpha"]',
    ) as HTMLButtonElement;
    assert.ok(checkingAction);
    assert.equal(checkingAction.disabled, true);
    checking.unmount();
});

test("Downloads UI plays ready copies and exposes retry/delete state actions", async () => {
    const base = {
        ownerId: "user-1",
        trackIdentity: "youtube:video-a",
        quality: "auto",
        sourceUrl: "/api/ytmusic/stream/video-a",
        track,
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 6,
        totalBytes: 6,
        contentType: "audio/mpeg",
        persistenceGranted: false,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
    records = [
        {
            ...base,
            key: "ready-key",
            virtualUrl: "/__offline/audio/ready-key",
            status: "ready",
        },
        {
            ...base,
            key: "retry-key",
            virtualUrl: "/__offline/audio/retry-key",
            track: { ...track, id: "interrupted", title: "Interrupted song" },
            status: "interrupted",
            errorMessage: "The transfer stopped before the file was ready.",
        },
        {
            ...base,
            key: "failed-key",
            virtualUrl: "/__offline/audio/failed-key",
            track: { ...track, id: "failed", title: "Failed song" },
            status: "error",
            errorMessage: "The provider rejected this file.",
        },
    ];
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    await React.act(async () =>
        (
            view.container.querySelector(
                'button[aria-label="Воспроизвести: Alpha"]',
            ) as HTMLButtonElement
        ).click(),
    );
    await React.act(async () =>
        (
            view.container.querySelector(
                'button[aria-label="Повторить загрузку: Interrupted song"]',
            ) as HTMLButtonElement
        ).click(),
    );
    assert.equal(
        view.container.querySelector(
            'button[aria-label="Воспроизвести: Interrupted song"]',
        ),
        null,
    );
    assert.equal(
        view.container.querySelector('button[aria-label="Воспроизвести: Failed song"]'),
        null,
    );
    assert.match(
        view.container.querySelector('[data-download-status="interrupted"]')
            ?.textContent ?? "",
        /Загрузка прервана.*Повтор/i,
    );
    assert.match(
        view.container.querySelector('[data-download-status="error"]')
            ?.textContent ?? "",
        /Не удалось сохранить.*Повторить/i,
    );
    const deleteButtons = view.container.querySelectorAll(
        'button[aria-label="Удалить копию с устройства: Alpha"]',
    );
    confirmDelete = false;
    await React.act(async () =>
        (deleteButtons[0] as HTMLButtonElement).click(),
    );
    assert.deepEqual(calls.deletes, []);
    confirmDelete = true;
    await React.act(async () =>
        (deleteButtons[0] as HTMLButtonElement).click(),
    );
    assert.match(calls.confirmations[0], /только с этого устройства/i);

    assert.deepEqual(calls.prepares, ["ready-key"]);
    assert.deepEqual(calls.plays, ["yt:video-a"]);
    assert.deepEqual(calls.resumes, ["retry-key"]);
    assert.deepEqual(calls.deletes, ["ready-key"]);
    view.unmount();
});

test("browser-private Downloads offers an explicit normal-file export without replacing offline playback", async () => {
    storage = {
        status: "ready",
        directoryName: "Soundspan on this device",
        storageKind: "browser-private",
        explanation:
            "Offline playback works, but the browser declined durable private storage. Use Save as file in Downloads because browser data may be cleared.",
    };
    records = [
        {
            ownerId: "user-1",
            trackIdentity: "youtube:video-a",
            quality: "auto",
            sourceUrl: "/api/ytmusic/stream/video-a",
            track,
            status: "ready",
            transferMode: "foreground",
            backgroundFetchId: null,
            bytesReceived: 6,
            totalBytes: 6,
            contentType: "audio/mpeg",
            persistenceGranted: false,
            attempt: 1,
            createdAt: 1,
            updatedAt: 1,
            errorCode: null,
            errorMessage: null,
            key: "private-ready-key",
            virtualUrl: "/__offline/audio/private-ready-key",
            mediaRef: "opfs1:owner:file",
        },
    ];
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    assert.match(
        view.container.textContent ?? "",
        /Личное хранилище Soundspan/i,
    );
    assert.match(
        view.container.textContent ?? "",
        /browser data may be cleared/i,
    );
    const save = view.container.querySelector(
        'button[aria-label="Сохранить как обычный файл: Alpha"]',
    ) as HTMLButtonElement;
    assert.ok(save);
    await React.act(async () => {
        save.click();
        await Promise.resolve();
    });
    assert.deepEqual(calls.exports, ["private-ready-key"]);
    assert.ok(view.container.querySelector('button[aria-label="Воспроизвести: Alpha"]'));
    view.unmount();
});

test("Downloads distinguishes manual and automatic copies and warns before automatic deletion", async () => {
    const base = {
        ownerId: "user-1",
        trackIdentity: "youtube:video-a",
        quality: "auto",
        sourceUrl: "/api/ytmusic/stream/video-a",
        track,
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 6,
        totalBytes: 6,
        contentType: "audio/mpeg",
        persistenceGranted: false,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
    records = [
        {
            ...base,
            key: "manual-key",
            track: { ...track, id: "manual", title: "Manual copy" },
            trackIdentity: "youtube:manual",
            management: "manual",
        },
        {
            ...base,
            key: "automatic-key",
            track: { ...track, id: "automatic", title: "Automatic copy" },
            trackIdentity: "youtube:automatic",
            management: "auto-liked",
        },
    ];
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    assert.match(view.container.textContent ?? "", /Сохранено офлайн вручную/i);
    assert.match(
        view.container.textContent ?? "",
        /Автоматически из любимых треков/i,
    );
    await React.act(async () =>
        (
            view.container.querySelector(
                'button[aria-label="Удалить копию с устройства: Automatic copy"]',
            ) as HTMLButtonElement
        ).click(),
    );
    assert.match(calls.confirmations.at(-1) ?? "", /может загрузиться снова/i);
    assert.deepEqual(calls.deletes, ["automatic-key"]);
    view.unmount();
});

test("Downloads UI does not fall through to a network play when the local cache is unavailable", async () => {
    records = [
        {
            ownerId: "user-1",
            trackIdentity: "youtube:video-a",
            quality: "auto",
            sourceUrl: "/api/ytmusic/stream-public/video-a",
            track,
            transferMode: "foreground",
            backgroundFetchId: null,
            bytesReceived: 6,
            totalBytes: 6,
            contentType: "audio/mp4",
            persistenceGranted: true,
            attempt: 1,
            createdAt: 1,
            updatedAt: 1,
            errorCode: null,
            errorMessage: null,
            key: "missing-cache-key",
            virtualUrl: "/__offline/audio/missing-cache-key",
            status: "ready",
        },
    ];
    prepareFailure = new Error("cache missing");
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    await React.act(async () => {
        (
            view.container.querySelector(
                'button[aria-label="Воспроизвести: Alpha"]',
            ) as HTMLButtonElement
        ).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(calls.prepares, ["missing-cache-key"]);
    assert.deepEqual(calls.plays, []);
    view.unmount();
});

test("Downloads UI keeps a zero-byte legacy background transfer pending and unplayable", async () => {
    records = [
        {
            ownerId: "user-1",
            trackIdentity: "youtube:video-a",
            quality: "auto",
            sourceUrl: "/api/ytmusic/stream-public/video-a",
            track,
            transferMode: "background",
            backgroundFetchId: "soundspan-device-audio-background-key::1",
            bytesReceived: 0,
            totalBytes: null,
            contentType: null,
            persistenceGranted: false,
            attempt: 1,
            createdAt: 1,
            updatedAt: 1,
            errorCode: null,
            errorMessage: null,
            key: "background-key",
            virtualUrl: "/__offline/audio/background-key",
            status: "downloading",
        },
    ];
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    assert.match(
        view.container.textContent ?? "",
        /Подготавливаем аудио.*прогресс появится, когда файл будет готов/i,
    );
    assert.doesNotMatch(view.container.textContent ?? "", /0%/);
    const playButton = view.container.querySelector(
        'button[aria-label="Воспроизвести: Alpha"]',
    ) as HTMLButtonElement;
    assert.equal(playButton.disabled, true);
    await React.act(async () => playButton.click());
    assert.deepEqual(calls.prepares, []);
    assert.deepEqual(calls.plays, []);
    view.unmount();
});

test("Downloads UI reports foreground bytes and percentage without claiming ready", async () => {
    records = [
        {
            ownerId: "user-1",
            trackIdentity: "youtube:video-a",
            quality: "auto",
            sourceUrl: "/api/ytmusic/stream-public/video-a",
            track,
            transferMode: "foreground",
            backgroundFetchId: null,
            foregroundLeaseId: "foreground",
            foregroundLeaseExpiresAt: Date.now() + 30_000,
            bytesReceived: 3,
            totalBytes: 6,
            contentType: "audio/mp4",
            persistenceGranted: true,
            attempt: 1,
            createdAt: 1,
            updatedAt: 1,
            errorCode: null,
            errorMessage: null,
            key: "progress-key",
            virtualUrl: "/__offline/audio/progress-key",
            status: "downloading",
        },
    ];
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    assert.match(view.container.textContent ?? "", /Загрузка: 50%/i);
    assert.match(view.container.textContent ?? "", /3 B из 6 B/i);
    const play = view.container.querySelector(
        'button[aria-label="Воспроизвести: Alpha"]',
    ) as HTMLButtonElement;
    assert.equal(play.disabled, true);

    records = [{ ...records[0], totalBytes: null, bytesReceived: 4 }];
    view.unmount();
    const unknown = await render(React.createElement(DownloadsList));
    assert.match(unknown.container.textContent ?? "", /получено 4 B/i);
    assert.doesNotMatch(unknown.container.textContent ?? "", /%/);
    unknown.unmount();
});

test("Downloads UI handles retry and delete failures without unhandled promises", async () => {
    records = [
        {
            ownerId: "user-1",
            trackIdentity: "youtube:video-a",
            quality: "auto",
            sourceUrl: "/api/ytmusic/stream/video-a",
            track,
            transferMode: "foreground",
            backgroundFetchId: null,
            bytesReceived: 0,
            totalBytes: null,
            contentType: null,
            persistenceGranted: false,
            attempt: 1,
            createdAt: 1,
            updatedAt: 1,
            errorCode: "interrupted",
            errorMessage: "Interrupted",
            key: "failed-key",
            virtualUrl: "/__offline/audio/failed-key",
            status: "interrupted",
        },
    ];
    resumeFailure = new Error("storage unavailable");
    deleteFailure = new Error("cache unavailable");
    const { DownloadsList } =
        await import("../../features/device-offline/components/DownloadsList");
    const view = await render(React.createElement(DownloadsList));

    await React.act(async () => {
        (
            view.container.querySelector(
                'button[aria-label="Повторить загрузку: Alpha"]',
            ) as HTMLButtonElement
        ).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await React.act(async () => {
        (
            view.container.querySelector(
                'button[aria-label="Удалить копию с устройства: Alpha"]',
            ) as HTMLButtonElement
        ).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(calls.resumes, ["failed-key"]);
    assert.deepEqual(calls.deletes, ["failed-key"]);
    view.unmount();
});

test("Library exposes Downloads as a directly selectable personal-collection tab", async () => {
    const { LibraryTabs } =
        await import("../../features/library/components/LibraryTabs");
    const view = await render(
        React.createElement(LibraryTabs, {
            activeTab: "overview",
        }),
    );
    const downloadsLink = [...view.container.querySelectorAll("a")].find(
        (candidate) => candidate.textContent === "Загрузки",
    );
    assert.ok(downloadsLink);
    assert.equal(downloadsLink.getAttribute("href"), "/library?tab=downloads");
    view.unmount();
});

test("the shared playable-track menu exposes device download for search rows", async () => {
    const { TrackOverflowMenu } =
        await import("../../components/ui/TrackOverflowMenu");
    const playableTrack = {
        id: "search-track",
        title: "Search result",
        duration: 180,
        artist: { name: "Artist" },
        album: { title: "Album" },
    };
    const view = await render(
        React.createElement(TrackOverflowMenu, { track: playableTrack }),
    );
    await React.act(async () =>
        (
            view.container.querySelector(
                'button[aria-label="Track actions"]',
            ) as HTMLButtonElement
        ).click(),
    );
    const downloadButton = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Download to device"),
    );
    assert.ok(downloadButton);
    await React.act(async () => downloadButton.click());
    assert.equal(
        calls.downloads.at(-1)?.sourceUrl,
        "/api/library/tracks/search-track/stream",
    );
    view.unmount();
});
