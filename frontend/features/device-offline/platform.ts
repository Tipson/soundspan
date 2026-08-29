import type { DeviceOfflineDownloadRecord } from "./types";

export interface BackgroundFetchManagerLike {
    fetch: (
        id: string,
        requests: Array<Request | string>,
        options: { title: string; downloadTotal?: number },
    ) => Promise<{ id: string }>;
    get?(id: string): Promise<
        | {
              id: string;
              abort?: () => Promise<boolean | void>;
          }
        | undefined
    >;
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

/** Whether a legacy Chromium registration is definitely gone. */
export type DeviceOfflineBackgroundFetchAbortResult = "cleared" | "unknown";
export const DEVICE_OFFLINE_BACKGROUND_FETCH_ID_PREFIX =
    "soundspan-device-audio-";

export const BROWSER_SERVICE_WORKER_LOOKUP_TIMEOUT_MS = 1_000;
const BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS = 5_000;
const DEVICE_OFFLINE_BACKGROUND_FETCH_PROTOCOL = 1;
const DEVICE_OFFLINE_WORKER_PROTOCOL_TIMEOUT_MS = 1_000;
// Chromium's Background Fetch can remain at 0% indefinitely for Soundspan's
// dynamically spooled audio responses. Keep the protocol code for safely
// reconciling/aborting registrations created by older clients, but route all
// new transfers through the observable, integrity-checked foreground path.
export const DEVICE_OFFLINE_BACKGROUND_FETCH_ENABLED = false;

interface DeviceOfflineServiceWorkerLike {
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
}

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

async function supportsDeviceOfflineBackgroundFetchProtocol(
    activeWorker: unknown,
    timeoutMs: number,
): Promise<boolean> {
    if (
        !activeWorker ||
        typeof activeWorker !== "object" ||
        typeof (activeWorker as Partial<DeviceOfflineServiceWorkerLike>)
            .postMessage !== "function" ||
        typeof MessageChannel === "undefined"
    ) {
        return false;
    }

    const channel = new MessageChannel();
    const response = new Promise<boolean>((resolve, reject) => {
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
            const message = event.data as {
                type?: unknown;
                backgroundFetchProtocol?: unknown;
            };
            resolve(
                message?.type === "DEVICE_OFFLINE_CAPABILITIES" &&
                    message.backgroundFetchProtocol ===
                        DEVICE_OFFLINE_BACKGROUND_FETCH_PROTOCOL,
            );
        };
        channel.port1.onmessageerror = () => reject(new Error("bad message"));
        try {
            (activeWorker as DeviceOfflineServiceWorkerLike).postMessage(
                { type: "DEVICE_OFFLINE_CAPABILITIES_REQUEST" },
                [channel.port2],
            );
        } catch (error) {
            reject(error);
        }
    });

    const settled = await settleBrowserOperationWithin(response, timeoutMs);
    channel.port1.onmessage = null;
    channel.port1.onmessageerror = null;
    channel.port1.close();
    channel.port2.close();
    return settled.state === "resolved" && settled.value;
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
    if (!DEVICE_OFFLINE_BACKGROUND_FETCH_ENABLED) {
        return resolveDeviceOfflineTransferCapability({
            userAgent,
            backgroundFetch: undefined,
        });
    }
    const serviceWorker =
        typeof navigator === "undefined" || !("serviceWorker" in navigator)
            ? null
            : (navigator.serviceWorker as BrowserServiceWorkerContainerLike);
    const inspection =
        await inspectBrowserServiceWorkerRegistration(serviceWorker);
    const supportsBackgroundProtocol =
        inspection.state === "active" &&
        (await supportsDeviceOfflineBackgroundFetchProtocol(
            inspection.registration.active,
            DEVICE_OFFLINE_WORKER_PROTOCOL_TIMEOUT_MS,
        ));
    return resolveDeviceOfflineTransferCapability({
        userAgent,
        backgroundFetch:
            inspection.state === "active" && supportsBackgroundProtocol
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
    if (
        DEVICE_OFFLINE_BACKGROUND_FETCH_ENABLED &&
        isAndroid &&
        typeof input.backgroundFetch?.fetch === "function"
    ) {
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
            : isAndroid
              ? "Keep soundspan open until the track is saved and verified on this Android device. Interrupted items can be retried from Downloads."
              : "Keep soundspan open until the track finishes. Interrupted items can be resumed from the Downloads tab.",
    };
}

export function backgroundFetchIdForKey(key: string, attempt: number): string {
    return `${DEVICE_OFFLINE_BACKGROUND_FETCH_ID_PREFIX}${encodeURIComponent(key)}::${attempt}`;
}

/** Start Background Fetch only on an Android registration that exposes it. */
export async function startBrowserBackgroundFetch(
    record: DeviceOfflineDownloadRecord,
    sourceUrl: string,
    runtime: BrowserBackgroundFetchRuntimeOptions = {},
): Promise<DeviceOfflineBackgroundFetchStartResult> {
    if (!DEVICE_OFFLINE_BACKGROUND_FETCH_ENABLED) return "unavailable";

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
    const operationTimeoutMs =
        runtime.operationTimeoutMs ??
        BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS;
    if (
        !(await supportsDeviceOfflineBackgroundFetchProtocol(
            registration.active,
            Math.min(
                operationTimeoutMs,
                DEVICE_OFFLINE_WORKER_PROTOCOL_TIMEOUT_MS,
            ),
        ))
    ) {
        return "unavailable";
    }
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
            operationTimeoutMs,
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
        operationTimeoutMs,
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
    runtime: BrowserBackgroundFetchRuntimeOptions = {},
): Promise<DeviceOfflineBackgroundFetchAbortResult> {
    const serviceWorker =
        runtime.serviceWorker ??
        (typeof navigator !== "undefined" && "serviceWorker" in navigator
            ? (navigator.serviceWorker as BrowserServiceWorkerContainerLike)
            : null);
    if (!serviceWorker) {
        return "unknown";
    }
    const inspection = await inspectBrowserServiceWorkerRegistration(
        serviceWorker,
        runtime.lookupTimeoutMs,
    );
    if (inspection.state === "unknown") return "unknown";
    if (inspection.state !== "active") return "cleared";
    const getActive = inspection.registration.backgroundFetch?.get;
    if (!getActive) return "unknown";
    const activeLookup = await settleBrowserOperationWithin(
        getActive.call(
            inspection.registration.backgroundFetch,
            record.backgroundFetchId ??
                backgroundFetchIdForKey(record.key, record.attempt),
        ),
        runtime.operationTimeoutMs ??
            BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS,
    );
    if (activeLookup.state !== "resolved") return "unknown";
    const active = activeLookup.value;
    if (!active) return "cleared";
    const abort = active?.abort;
    if (!abort) return "unknown";
    const aborted = await settleBrowserOperationWithin(
        abort.call(active),
        runtime.operationTimeoutMs ??
            BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS,
    );
    return aborted.state === "resolved" && aborted.value !== false
        ? "cleared"
        : "unknown";
}

/**
 * Retire every legacy Soundspan Background Fetch registration, including
 * orphans whose media metadata was already deleted or replaced.
 */
export async function sweepLegacyBrowserBackgroundFetches(
    runtime: BrowserBackgroundFetchRuntimeOptions = {},
): Promise<DeviceOfflineBackgroundFetchAbortResult> {
    const serviceWorker =
        runtime.serviceWorker ??
        (typeof navigator !== "undefined" && "serviceWorker" in navigator
            ? (navigator.serviceWorker as BrowserServiceWorkerContainerLike)
            : null);
    if (!serviceWorker) return "unknown";

    const inspection = await inspectBrowserServiceWorkerRegistration(
        serviceWorker,
        runtime.lookupTimeoutMs,
    );
    if (inspection.state === "unknown") return "unknown";
    if (inspection.state !== "active") return "cleared";

    const manager = inspection.registration.backgroundFetch;
    if (!manager) return "cleared";
    if (!manager.getIds || !manager.get) return "unknown";
    const timeoutMs =
        runtime.operationTimeoutMs ??
        BROWSER_BACKGROUND_FETCH_OPERATION_TIMEOUT_MS;
    const idsResult = await settleBrowserOperationWithin(
        manager.getIds.call(manager),
        timeoutMs,
    );
    if (idsResult.state !== "resolved") return "unknown";

    const ids = idsResult.value.filter((id) =>
        id.startsWith(DEVICE_OFFLINE_BACKGROUND_FETCH_ID_PREFIX),
    );
    let allCleared = true;
    for (const id of ids) {
        const lookup = await settleBrowserOperationWithin(
            manager.get.call(manager, id),
            timeoutMs,
        );
        if (lookup.state !== "resolved") {
            allCleared = false;
            continue;
        }
        const registration = lookup.value;
        if (!registration) continue;
        if (!registration.abort) {
            allCleared = false;
            continue;
        }
        const aborted = await settleBrowserOperationWithin(
            registration.abort.call(registration),
            timeoutMs,
        );
        if (aborted.state !== "resolved" || aborted.value === false) {
            allCleared = false;
        }
    }
    return allCleared ? "cleared" : "unknown";
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
