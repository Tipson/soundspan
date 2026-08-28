import type { DeviceOfflineDownloadRecord } from "./types";

export interface BackgroundFetchManagerLike {
    fetch: (
        id: string,
        requests: Array<Request | string>,
        options: { title: string; downloadTotal?: number },
    ) => Promise<{ id: string }>;
    get?(id: string): Promise<{ id: string } | undefined>;
    getIds?(): Promise<string[]>;
}

export interface BackgroundFetchRegistrationLike {
    active?: unknown;
    backgroundFetch?: BackgroundFetchManagerLike;
}

export interface BrowserServiceWorkerContainerLike {
    getRegistration?(): Promise<
        BackgroundFetchRegistrationLike | null | undefined
    >;
}

export type BrowserServiceWorkerRegistrationInspection =
    | {
          state: "active";
          registration: BackgroundFetchRegistrationLike;
      }
    | {
          state: "unavailable";
          registration: null;
      }
    | {
          state: "unknown";
          registration: null;
      };

export interface DeviceOfflineTransferCapability {
    mode: "background" | "foreground";
    explanation: string;
}

export interface BrowserBackgroundFetchRuntimeOptions {
    serviceWorker?: BrowserServiceWorkerContainerLike;
    userAgent?: string;
    lookupTimeoutMs?: number;
    operationTimeoutMs?: number;
}

export type DeviceOfflineBackgroundFetchStartResult =
    | "started"
    | "unavailable"
    | "unknown";

export const BROWSER_SERVICE_WORKER_LOOKUP_TIMEOUT_MS = 1_000;
const BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS = 5_000;

type BoundedOperationResult<T> =
    | { state: "resolved"; value: T }
    | { state: "rejected" | "timeout" };

function settleBrowserOperationWithin<T>(
    operation: Promise<T>,
    timeoutMs: number,
): Promise<BoundedOperationResult<T>> {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(
            () => {
                if (settled) return;
                settled = true;
                resolve({ state: "timeout" });
            },
            Math.max(0, timeoutMs),
        );

        void operation.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ state: "resolved", value });
            },
            () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ state: "rejected" });
            },
        );
    });
}

/** Inspect an already-active registration without waiting for first install. */
export async function inspectBrowserServiceWorkerRegistration(
    serviceWorker: BrowserServiceWorkerContainerLike | null | undefined,
    timeoutMs = BROWSER_SERVICE_WORKER_LOOKUP_TIMEOUT_MS,
): Promise<BrowserServiceWorkerRegistrationInspection> {
    if (typeof serviceWorker?.getRegistration !== "function") {
        return { state: "unavailable", registration: null };
    }

    const lookup = await settleBrowserOperationWithin(
        serviceWorker.getRegistration(),
        timeoutMs,
    );
    if (lookup.state !== "resolved") {
        return { state: "unknown", registration: null };
    }
    if (!lookup.value?.active) {
        return { state: "unavailable", registration: null };
    }
    return { state: "active", registration: lookup.value };
}

export async function resolveBrowserDeviceOfflineTransferCapability(): Promise<DeviceOfflineTransferCapability> {
    const userAgent =
        typeof navigator === "undefined" ? "" : navigator.userAgent;
    const serviceWorker =
        typeof navigator === "undefined" || !("serviceWorker" in navigator)
            ? null
            : (navigator.serviceWorker as BrowserServiceWorkerContainerLike);
    const inspection =
        await inspectBrowserServiceWorkerRegistration(serviceWorker);
    return resolveDeviceOfflineTransferCapability({
        userAgent,
        backgroundFetch:
            inspection.state === "active"
                ? inspection.registration.backgroundFetch
                : undefined,
    });
}

/** Resolve the honest transfer behavior from the live browser capability. */
export function resolveDeviceOfflineTransferCapability(input: {
    userAgent: string;
    backgroundFetch: BackgroundFetchManagerLike | undefined;
}): DeviceOfflineTransferCapability {
    const isAndroid = /Android/i.test(input.userAgent);
    if (isAndroid && typeof input.backgroundFetch?.fetch === "function") {
        return {
            mode: "background",
            explanation:
                "Android can continue this download through the browser's Background Fetch UI.",
        };
    }

    const isAppleMobile = /iPad|iPhone|iPod/i.test(input.userAgent);
    return {
        mode: "foreground",
        explanation: isAppleMobile
            ? "Keep soundspan open until the track finishes. iPhone resumes an interrupted item by restarting that foreground transfer."
            : "Keep soundspan open until the track finishes. Interrupted items can be resumed from the Downloads tab.",
    };
}

export function backgroundFetchIdForKey(key: string, attempt: number): string {
    return `soundspan-device-audio-${encodeURIComponent(key)}::${attempt}`;
}

/** Start Background Fetch only on an Android registration that exposes it. */
export async function startBrowserBackgroundFetch(
    record: DeviceOfflineDownloadRecord,
    sourceUrl: string,
    runtime: BrowserBackgroundFetchRuntimeOptions = {},
): Promise<DeviceOfflineBackgroundFetchStartResult> {
    const serviceWorker =
        runtime.serviceWorker ??
        (typeof navigator !== "undefined" && "serviceWorker" in navigator
            ? (navigator.serviceWorker as BrowserServiceWorkerContainerLike)
            : null);
    if (!serviceWorker) {
        return "unavailable";
    }

    const inspection = await inspectBrowserServiceWorkerRegistration(
        serviceWorker,
        runtime.lookupTimeoutMs,
    );
    if (inspection.state !== "active") return "unavailable";
    const registration = inspection.registration;
    const capability = resolveDeviceOfflineTransferCapability({
        userAgent:
            runtime.userAgent ??
            (typeof navigator === "undefined" ? "" : navigator.userAgent),
        backgroundFetch: registration.backgroundFetch,
    });
    if (capability.mode !== "background" || !registration.backgroundFetch) {
        return "unavailable";
    }

    const id = backgroundFetchIdForKey(record.key, record.attempt);
    if (registration.backgroundFetch.get) {
        const existing = await settleBrowserOperationWithin(
            registration.backgroundFetch.get(id),
            runtime.operationTimeoutMs ??
                BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS,
        );
        if (existing.state !== "resolved") return "unavailable";
        if (existing.value) return "started";
    }

    const startBackgroundTransfer = registration.backgroundFetch.fetch.bind(
        registration.backgroundFetch,
    );
    const started = await settleBrowserOperationWithin(
        startBackgroundTransfer(
            id,
            [new Request(sourceUrl, { credentials: "include" })],
            {
                title: `Download ${record.track.title}`,
                ...(record.totalBytes
                    ? { downloadTotal: record.totalBytes }
                    : {}),
            },
        ),
        runtime.operationTimeoutMs ??
            BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS,
    );
    // Starting Background Fetch is side-effectful: after an ambiguous timeout
    // the browser operation may still
    // register in Chromium. Expose that uncertainty so the manager can keep
    // a bounded verification lease without starting a duplicate foreground
    // transfer for this attempt.
    return started.state === "resolved"
        ? "started"
        : started.state === "timeout"
          ? "unknown"
          : "unavailable";
}

export async function abortBrowserBackgroundFetch(
    record: DeviceOfflineDownloadRecord,
): Promise<void> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return;
    }
    const inspection = await inspectBrowserServiceWorkerRegistration(
        navigator.serviceWorker as BrowserServiceWorkerContainerLike,
    );
    if (inspection.state !== "active") return;
    const getActive = inspection.registration.backgroundFetch?.get;
    if (!getActive) return;
    const activeLookup = await settleBrowserOperationWithin(
        getActive.call(
            inspection.registration.backgroundFetch,
            record.backgroundFetchId ??
                backgroundFetchIdForKey(record.key, record.attempt),
        ),
        BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS,
    );
    if (activeLookup.state !== "resolved") return;
    const active = activeLookup.value;
    const abort = (active as { abort?: () => Promise<void> } | undefined)
        ?.abort;
    if (abort) {
        await settleBrowserOperationWithin(
            abort.call(active),
            BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS,
        );
    }
}

export async function listBrowserBackgroundFetchIds(): Promise<string[]> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return [];
    }
    const inspection = await inspectBrowserServiceWorkerRegistration(
        navigator.serviceWorker as BrowserServiceWorkerContainerLike,
    );
    if (inspection.state === "unavailable") return [];
    if (inspection.state === "unknown") {
        throw new Error("Service Worker registration status is unknown");
    }
    const getIds = inspection.registration.backgroundFetch?.getIds;
    if (!getIds) return [];
    const ids = await settleBrowserOperationWithin(
        getIds.call(inspection.registration.backgroundFetch),
        BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS,
    );
    if (ids.state !== "resolved") {
        throw new Error("Background Fetch enumeration timed out");
    }
    return ids.value;
}
