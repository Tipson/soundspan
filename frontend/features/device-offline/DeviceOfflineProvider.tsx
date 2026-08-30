"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { api } from "@/lib/api";
import { getAuthRuntimeLease } from "@/lib/auth-runtime-generation";
import type { Track } from "@/lib/audio-state-context";
import { useAuth } from "@/lib/auth-context";
import { getBrowserDeviceOfflineQueueManager } from "./browserQueueStorage";
import {
    createBrowserDeviceOfflinePlaybackSource,
    getBrowserDeviceOfflineManager,
} from "./browserStorage";
import {
    isLikedPlaylistTrackDownloadable,
    likedPlaylistTrackToDeviceTrack,
    subscribeToDeviceOfflineLikedChanges,
} from "./likedAutomation";
import {
    summarizeDeviceOfflineCollection,
    type DeviceOfflineAutomationSettings,
    type DeviceOfflineBatchEnqueueResult,
    type DeviceOfflineCollectionStatus,
    type DeviceOfflineQueueItem,
} from "./offlineQueue";
import {
    clearDeviceOfflineRuntimeState,
    hasPreparedDeviceOfflinePlaybackSource,
    prepareDeviceOfflinePlaybackSource,
    setDeviceOfflineRuntimeState,
} from "./playbackResolver";
import {
    resolveBrowserDeviceOfflineTransferCapability,
    resolveDeviceOfflineTransferCapability,
} from "./platform";
import { startPhysicalFileDownload } from "./physicalFileExport";
import { DeviceOfflineSessionGuard } from "./sessionGuard";
import { getDeviceDownloadSourceUrl } from "./sourceUrl";
import { resolveDeviceOfflineTrackIdentity } from "./trackIdentity";
import {
    getDeviceAudioVault,
    type DeviceAudioAccessState,
    type DeviceAudioStorageKind,
} from "./vault";
import type {
    DeviceOfflineDownloadInput,
    DeviceOfflineDownloadRecord,
    DeviceOfflineTrack,
} from "./types";

export interface DeviceOfflineCollectionDownloadInput {
    tracks: Track[];
    collectionId: string;
    collectionLabel: string;
    quality?: string;
}

export interface DeviceOfflineStorageState {
    status:
        | "checking"
        | "needs-setup"
        | "requesting"
        | "ready"
        | "unsupported"
        | "error";
    directoryName: string | null;
    storageKind: DeviceAudioStorageKind | null;
    explanation: string;
}

const DEVICE_FOLDER_UNSUPPORTED_EXPLANATION =
    "Этот браузер не поддерживает запись в хранилище устройства. Обновите браузер, используйте Chrome или Edge для обычной папки с музыкой там, где это поддерживается, либо нативное приложение Soundspan.";

const INITIAL_DEVICE_OFFLINE_STORAGE: DeviceOfflineStorageState = {
    status: "checking",
    directoryName: null,
    storageKind: null,
    explanation:
        "Проверяем, может ли это устройство хранить музыкальные файлы…",
};

function toDeviceOfflineStorageState(
    access: DeviceAudioAccessState,
): DeviceOfflineStorageState {
    if (access.status === "ready") {
        return {
            status: "ready",
            directoryName: access.label || null,
            storageKind: access.storageKind,
            explanation: access.reason,
        };
    }
    if (
        access.status === "setup-required" ||
        access.status === "permission-required"
    ) {
        return {
            status: "needs-setup",
            directoryName: access.label || null,
            storageKind: access.storageKind,
            explanation: access.reason,
        };
    }
    if (access.status === "unsupported") {
        return {
            status: "unsupported",
            directoryName: null,
            storageKind: null,
            explanation: DEVICE_FOLDER_UNSUPPORTED_EXPLANATION,
        };
    }
    return {
        status: "error",
        directoryName: access.label || null,
        storageKind: access.storageKind,
        explanation: access.reason,
    };
}

function toDeviceOfflineStorageFailure(
    error: unknown,
): DeviceOfflineStorageState {
    const code =
        error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : null;
    if (code === "user_cancelled") {
        return {
            status: "needs-setup",
            directoryName: null,
            storageKind: null,
            explanation:
                "Папка не выбрана. Когда будете готовы скачать музыку, выберите папку.",
        };
    }
    if (code === "unsupported") {
        return {
            status: "unsupported",
            directoryName: null,
            storageKind: null,
            explanation: DEVICE_FOLDER_UNSUPPORTED_EXPLANATION,
        };
    }
    return {
        status: "error",
        directoryName: null,
        storageKind: null,
        explanation:
            error instanceof Error && error.message
                ? error.message
                : "Soundspan не удалось открыть хранилище устройства. Выберите папку снова и разрешите доступ к файлам.",
    };
}

export interface DeviceOfflineContextValue {
    isHydrated: boolean;
    isQueueHydrated: boolean;
    storageError: string | null;
    storage: DeviceOfflineStorageState;
    records: DeviceOfflineDownloadRecord[];
    queueItems: DeviceOfflineQueueItem[];
    automationSettings: DeviceOfflineAutomationSettings | null;
    capability: ReturnType<typeof resolveDeviceOfflineTransferCapability>;
    download(
        input: Omit<DeviceOfflineDownloadInput, "ownerId">,
    ): Promise<DeviceOfflineDownloadRecord>;
    resume(record: DeviceOfflineDownloadRecord): Promise<void>;
    preparePlayback(record: DeviceOfflineDownloadRecord): Promise<void>;
    exportDownload(record: DeviceOfflineDownloadRecord): Promise<string>;
    deleteDownload(key: string): Promise<void>;
    cancelQueuedDownload(item: DeviceOfflineQueueItem): Promise<void>;
    recordForTrack(
        track: DeviceOfflineTrack,
    ): DeviceOfflineDownloadRecord | null;
    enqueueCollection(
        input: DeviceOfflineCollectionDownloadInput,
    ): Promise<DeviceOfflineBatchEnqueueResult>;
    collectionStatus(
        tracks: DeviceOfflineTrack[],
        quality?: string,
    ): DeviceOfflineCollectionStatus;
    updateAutomationSettings(
        patch: Partial<
            Pick<
                DeviceOfflineAutomationSettings,
                "autoDownloadLiked" | "autoDownloadLikedLimit"
            >
        >,
    ): Promise<void>;
    setupStorage(): Promise<DeviceOfflineStorageState>;
    retryStorage(): Promise<void>;
    refresh(): Promise<void>;
}

const DeviceOfflineContext = createContext<DeviceOfflineContextValue | null>(
    null,
);
const EMPTY_DEVICE_OFFLINE_RECORDS: DeviceOfflineDownloadRecord[] = [];
const EMPTY_DEVICE_OFFLINE_QUEUE: DeviceOfflineQueueItem[] = [];
const DEVICE_STORAGE_READ_ERROR =
    "Не удалось прочитать всё хранилище устройства. Ранее загруженные треки по возможности останутся видны; повторите попытку, прежде чем менять настройки офлайн-доступа.";

export function DeviceOfflineProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const { user } = useAuth();
    const ownerId = user?.id ?? null;
    const [snapshot, setSnapshot] = useState<{
        ownerId: string | null;
        records: DeviceOfflineDownloadRecord[];
        hydrated: boolean;
        error: string | null;
    }>({ ownerId: null, records: [], hydrated: false, error: null });
    const records =
        snapshot.ownerId === ownerId
            ? snapshot.records
            : EMPTY_DEVICE_OFFLINE_RECORDS;
    const recordsHydrated = snapshot.ownerId === ownerId && snapshot.hydrated;
    const [queueSnapshot, setQueueSnapshot] = useState<{
        ownerId: string | null;
        items: DeviceOfflineQueueItem[];
        settings: DeviceOfflineAutomationSettings | null;
        hydrated: boolean;
        error: string | null;
    }>({
        ownerId: null,
        items: [],
        settings: null,
        hydrated: false,
        error: null,
    });
    const queueItems =
        queueSnapshot.ownerId === ownerId
            ? queueSnapshot.items
            : EMPTY_DEVICE_OFFLINE_QUEUE;
    const automationSettings =
        queueSnapshot.ownerId === ownerId ? queueSnapshot.settings : null;
    // Audio runtime readiness depends only on the playback-record database.
    // The optional automation queue has an independent gate so its failure
    // cannot disable online or already-downloaded playback.
    const isHydrated = recordsHydrated;
    const isQueueHydrated =
        queueSnapshot.ownerId === ownerId && queueSnapshot.hydrated;
    const storageError =
        snapshot.ownerId === ownerId && snapshot.error
            ? snapshot.error
            : queueSnapshot.ownerId === ownerId
              ? queueSnapshot.error
              : null;
    const [sessionGuard] = useState(
        () => new DeviceOfflineSessionGuard(ownerId),
    );
    const [queueSessionGuard] = useState(
        () => new DeviceOfflineSessionGuard(ownerId),
    );
    const [automationSessionGuard] = useState(
        () => new DeviceOfflineSessionGuard(ownerId),
    );
    const autoSyncPromises = useRef(
        new Map<string, { dirty: boolean; promise: Promise<void> }>(),
    );
    const reconciledOwnerRef = useRef<string | null>(null);
    const reconcileRequestRef = useRef<{
        ownerId: string;
        dirty: boolean;
        request: Promise<DeviceOfflineDownloadRecord[]>;
    } | null>(null);
    const storageProbeGenerationRef = useRef(0);
    const storageSetupPromiseRef =
        useRef<Promise<DeviceOfflineStorageState> | null>(null);
    const legacyMigrationRunRef = useRef<{
        ownerId: string;
        authGeneration: number;
        complete: boolean;
        promise: Promise<void> | null;
    } | null>(null);
    const [storage, setStorage] = useState<DeviceOfflineStorageState>(
        INITIAL_DEVICE_OFFLINE_STORAGE,
    );
    const vault = useMemo(
        () => (typeof window === "undefined" ? null : getDeviceAudioVault()),
        [],
    );
    const manager = useMemo(
        () =>
            typeof window === "undefined"
                ? null
                : getBrowserDeviceOfflineManager(),
        [],
    );
    const queueManager = useMemo(
        () =>
            typeof window === "undefined" || !manager
                ? null
                : getBrowserDeviceOfflineQueueManager(manager),
        [manager],
    );
    const ownerAuthRuntimeLease = useMemo(
        () => (ownerId ? getAuthRuntimeLease() : null),
        [ownerId],
    );
    const [capability, setCapability] = useState(() =>
        resolveDeviceOfflineTransferCapability({
            userAgent:
                typeof navigator === "undefined" ? "" : navigator.userAgent,
            backgroundFetch: undefined,
        }),
    );

    useEffect(() => {
        if (!ownerId || !ownerAuthRuntimeLease) return;
        manager?.activateOwner(ownerId, ownerAuthRuntimeLease);
        queueManager?.activateOwner(ownerId, ownerAuthRuntimeLease);
        return () => {
            queueManager?.retireOwner(ownerId, ownerAuthRuntimeLease);
            manager?.retireOwner(ownerId, ownerAuthRuntimeLease);
        };
    }, [manager, ownerAuthRuntimeLease, ownerId, queueManager]);

    useEffect(() => {
        if (
            typeof navigator === "undefined" ||
            !("serviceWorker" in navigator)
        ) {
            return;
        }
        let active = true;
        let refreshGeneration = 0;
        const serviceWorker = navigator.serviceWorker;
        const refreshCapability = () => {
            const generation = ++refreshGeneration;
            void resolveBrowserDeviceOfflineTransferCapability().then(
                (nextCapability) => {
                    if (active && generation === refreshGeneration) {
                        setCapability(nextCapability);
                    }
                },
                () => undefined,
            );
        };
        refreshCapability();
        serviceWorker.addEventListener("controllerchange", refreshCapability);
        return () => {
            active = false;
            refreshGeneration++;
            serviceWorker.removeEventListener(
                "controllerchange",
                refreshCapability,
            );
        };
    }, []);

    useEffect(() => {
        const generation = ++storageProbeGenerationRef.current;
        if (!vault) {
            setStorage({
                status: "unsupported",
                directoryName: null,
                storageKind: null,
                explanation: DEVICE_FOLDER_UNSUPPORTED_EXPLANATION,
            });
            return;
        }
        let active = true;
        void vault.inspectAccess().then(
            (access) => {
                if (
                    active &&
                    generation === storageProbeGenerationRef.current
                ) {
                    setStorage(toDeviceOfflineStorageState(access));
                }
            },
            () => {
                if (
                    active &&
                    generation === storageProbeGenerationRef.current
                ) {
                    setStorage({
                        status: "error",
                        directoryName: null,
                        storageKind: null,
                        explanation:
                            "Soundspan не удалось проверить доступ к папке на устройстве. Попробуйте выбрать папку снова.",
                    });
                }
            },
        );
        return () => {
            active = false;
        };
    }, [vault]);

    const load = useCallback(
        async (reconcile: boolean) => {
            const token = sessionGuard.begin(ownerId);
            if (!token) return;
            if (!manager || !ownerId) {
                sessionGuard.publishIfCurrent(token, () => {
                    clearDeviceOfflineRuntimeState();
                    setSnapshot({
                        ownerId,
                        records: [],
                        hydrated: true,
                        error: null,
                    });
                });
                return;
            }
            let next: DeviceOfflineDownloadRecord[];
            try {
                next = await manager.list(ownerId);
            } catch {
                sessionGuard.publishIfCurrent(token, () => {
                    setSnapshot((previous) =>
                        previous.ownerId === ownerId
                            ? {
                                  ...previous,
                                  error: DEVICE_STORAGE_READ_ERROR,
                              }
                            : {
                                  ownerId,
                                  records: [],
                                  // The storage attempt completed. Keep online
                                  // playback available while the error UI offers
                                  // a retry instead of pretending Downloads is empty.
                                  hydrated: true,
                                  error: DEVICE_STORAGE_READ_ERROR,
                              },
                    );
                });
                return;
            }
            const requiresReconcile =
                reconcile || reconciledOwnerRef.current !== ownerId;
            if (!requiresReconcile) {
                sessionGuard.publishIfCurrent(token, () => {
                    setSnapshot({
                        ownerId,
                        records: next,
                        hydrated: true,
                        error: null,
                    });
                    setDeviceOfflineRuntimeState(ownerId, next);
                });
                return;
            }
            try {
                let pendingReconcile = reconcileRequestRef.current;
                if (pendingReconcile?.ownerId !== ownerId) {
                    pendingReconcile = {
                        ownerId,
                        dirty: false,
                        request: Promise.resolve([]),
                    };
                    const activeReconcile = pendingReconcile;
                    activeReconcile.request = (async () => {
                        let reconciledRecords: DeviceOfflineDownloadRecord[];
                        do {
                            activeReconcile.dirty = false;
                            reconciledRecords =
                                await manager.reconcile(ownerId);
                        } while (activeReconcile.dirty);
                        return reconciledRecords;
                    })();
                    reconcileRequestRef.current = pendingReconcile;
                    const clearPending = () => {
                        if (reconcileRequestRef.current === activeReconcile) {
                            reconcileRequestRef.current = null;
                        }
                    };
                    void activeReconcile.request.then(
                        clearPending,
                        clearPending,
                    );
                } else {
                    // A notification that arrives while initial verification
                    // is running must cause one more pass. Reusing only the
                    // in-flight result could publish a snapshot captured just
                    // before the metadata/cache change that raised the event.
                    pendingReconcile.dirty = true;
                }
                next = await pendingReconcile.request;
            } catch {
                sessionGuard.publishIfCurrent(token, () => {
                    clearDeviceOfflineRuntimeState();
                    setSnapshot({
                        ownerId,
                        records: [],
                        hydrated: true,
                        error: DEVICE_STORAGE_READ_ERROR,
                    });
                });
                return;
            }
            sessionGuard.publishIfCurrent(token, () => {
                reconciledOwnerRef.current = ownerId;
                setSnapshot({
                    ownerId,
                    records: next,
                    hydrated: true,
                    error: null,
                });
                setDeviceOfflineRuntimeState(ownerId, next);
            });
        },
        [manager, ownerId, sessionGuard],
    );

    const resumeLegacyMigration = useCallback((): Promise<void> => {
        if (!manager || !ownerId || !ownerAuthRuntimeLease) {
            return Promise.resolve();
        }
        const authGeneration = ownerAuthRuntimeLease.generation;
        let run = legacyMigrationRunRef.current;
        if (
            !run ||
            run.ownerId !== ownerId ||
            run.authGeneration !== authGeneration
        ) {
            run = {
                ownerId,
                authGeneration,
                complete: false,
                promise: null,
            };
            legacyMigrationRunRef.current = run;
        }
        if (run.complete) return Promise.resolve();
        if (run.promise) return run.promise;

        const activeRun = run;
        const request = manager
            .migrateLegacyCache(ownerId)
            .then(() => load(false))
            .then(() => {
                if (legacyMigrationRunRef.current === activeRun) {
                    activeRun.complete = true;
                }
            })
            .finally(() => {
                if (legacyMigrationRunRef.current === activeRun) {
                    activeRun.promise = null;
                }
            });
        activeRun.promise = request;
        return request;
    }, [load, manager, ownerAuthRuntimeLease, ownerId]);

    const loadQueue = useCallback(async (): Promise<boolean> => {
        const token = queueSessionGuard.begin(ownerId);
        if (!token) return false;
        if (!queueManager || !ownerId) {
            return queueSessionGuard.publishIfCurrent(token, () => {
                setQueueSnapshot({
                    ownerId,
                    items: [],
                    settings: null,
                    hydrated: true,
                    error: null,
                });
            });
        }
        try {
            const [items, settings] = await Promise.all([
                queueManager.list(ownerId),
                queueManager.getSettings(ownerId),
            ]);
            return queueSessionGuard.publishIfCurrent(token, () => {
                setQueueSnapshot({
                    ownerId,
                    items,
                    settings,
                    hydrated: true,
                    error: null,
                });
            });
        } catch {
            queueSessionGuard.publishIfCurrent(token, () => {
                setQueueSnapshot((previous) =>
                    previous.ownerId === ownerId
                        ? {
                              ...previous,
                              error: DEVICE_STORAGE_READ_ERROR,
                          }
                        : {
                              ownerId,
                              items: [],
                              settings: null,
                              hydrated: false,
                              error: DEVICE_STORAGE_READ_ERROR,
                          },
                );
            });
            return false;
        }
    }, [ownerId, queueManager, queueSessionGuard]);

    useEffect(() => {
        sessionGuard.mount(ownerId);
        void load(true);
        return () => {
            sessionGuard.unmount();
            if (reconciledOwnerRef.current === ownerId) {
                reconciledOwnerRef.current = null;
            }
            clearDeviceOfflineRuntimeState();
        };
    }, [load, ownerId, sessionGuard]);

    useEffect(() => {
        queueSessionGuard.mount(ownerId);
        void loadQueue();
        if (queueManager && ownerId && storage.status === "ready") {
            void queueManager.resume(ownerId).catch(() => undefined);
        }
        return () => {
            if (queueManager && ownerId) queueManager.pause(ownerId);
            queueSessionGuard.unmount();
        };
    }, [loadQueue, ownerId, queueManager, queueSessionGuard, storage.status]);

    useEffect(() => {
        automationSessionGuard.mount(ownerId);
        return () => automationSessionGuard.unmount();
    }, [automationSessionGuard, ownerId]);

    useEffect(() => {
        if (!manager) return;
        const unsubscribe = manager.subscribe(() => void load(false));
        const handleWorkerMessage = (event: MessageEvent) => {
            if (event.data?.type === "DEVICE_OFFLINE_CHANGED") void load(false);
        };
        navigator.serviceWorker?.addEventListener(
            "message",
            handleWorkerMessage,
        );
        return () => {
            unsubscribe();
            navigator.serviceWorker?.removeEventListener(
                "message",
                handleWorkerMessage,
            );
        };
    }, [load, manager]);

    useEffect(() => {
        if (!queueManager) return;
        return queueManager.subscribe(() => void loadQueue());
    }, [loadQueue, queueManager]);

    useEffect(() => {
        if (!queueManager || !ownerId) return;
        const resumeQueue = () => {
            if (
                storage.status === "ready" &&
                navigator.onLine !== false &&
                document.visibilityState !== "hidden"
            ) {
                void queueManager
                    .resume(ownerId)
                    .catch(() => undefined)
                    .finally(loadQueue);
            }
        };
        const pauseQueue = () => queueManager.pause(ownerId);
        const handleVisibility = () => {
            if (document.visibilityState === "hidden") pauseQueue();
            else resumeQueue();
        };
        window.addEventListener("online", resumeQueue);
        window.addEventListener("offline", pauseQueue);
        window.addEventListener("focus", resumeQueue);
        document.addEventListener("visibilitychange", handleVisibility);
        return () => {
            window.removeEventListener("online", resumeQueue);
            window.removeEventListener("offline", pauseQueue);
            window.removeEventListener("focus", resumeQueue);
            document.removeEventListener("visibilitychange", handleVisibility);
        };
    }, [loadQueue, ownerId, queueManager, storage.status]);

    useEffect(() => {
        if (storage.status !== "ready") return;
        void resumeLegacyMigration().catch(() => undefined);
    }, [resumeLegacyMigration, storage.status]);

    const setupStorage = useCallback((): Promise<DeviceOfflineStorageState> => {
        if (storage.status === "ready") {
            return Promise.resolve(storage);
        }
        if (!vault) {
            const unsupported: DeviceOfflineStorageState = {
                status: "unsupported",
                directoryName: null,
                storageKind: null,
                explanation: DEVICE_FOLDER_UNSUPPORTED_EXPLANATION,
            };
            setStorage(unsupported);
            return Promise.resolve(unsupported);
        }
        const activeRequest = storageSetupPromiseRef.current;
        if (activeRequest) return activeRequest;

        const generation = ++storageProbeGenerationRef.current;
        setStorage({
            status: "requesting",
            directoryName: storage.directoryName,
            storageKind: storage.storageKind,
            explanation:
                "Выберите папку в системном окне и разрешите Soundspan записывать туда музыкальные файлы.",
        });

        let accessRequest: Promise<DeviceAudioAccessState>;
        try {
            // Deliberately invoke the picker synchronously in the caller's
            // click stack. Adding an await before this call breaks transient
            // user activation in browsers that implement directory access.
            accessRequest = vault.requestAccess();
        } catch (error) {
            accessRequest = Promise.reject(error);
        }
        const request = accessRequest
            .then(toDeviceOfflineStorageState, toDeviceOfflineStorageFailure)
            .then(async (next) => {
                if (next.status === "ready") {
                    await resumeLegacyMigration().catch(() => undefined);
                }
                if (generation === storageProbeGenerationRef.current) {
                    setStorage(next);
                }
                return next;
            })
            .finally(() => {
                if (storageSetupPromiseRef.current === request) {
                    storageSetupPromiseRef.current = null;
                }
            });
        storageSetupPromiseRef.current = request;
        return request;
    }, [resumeLegacyMigration, storage, vault]);

    const requireManualStorage = useCallback(async () => {
        const next =
            storage.status === "ready" ? storage : await setupStorage();
        if (next.status !== "ready") {
            throw new Error(next.explanation);
        }
        return next;
    }, [setupStorage, storage]);

    const syncAutoLiked = useCallback((): Promise<void> => {
        if (!queueManager || !ownerId || storage.status !== "ready") {
            return Promise.resolve();
        }
        const active = autoSyncPromises.current.get(ownerId);
        if (active) {
            active.dirty = true;
            return active.promise;
        }
        const token = automationSessionGuard.begin(ownerId);
        if (!token) return Promise.resolve();
        const isCurrentSession = () =>
            automationSessionGuard.publishIfCurrent(token, () => undefined);

        const entry = { dirty: false, promise: Promise.resolve() };
        const execute = async () => {
            do {
                entry.dirty = false;
                if (
                    navigator.onLine === false ||
                    document.visibilityState === "hidden"
                ) {
                    return;
                }
                const settings = await queueManager.getSettings(ownerId);
                if (!settings.autoDownloadLiked || !isCurrentSession()) return;
                const liked = await api.getLikedPlaylist({ limit: 10_000 });
                if (!isCurrentSession()) return;
                const newestLiked = [...liked.tracks].sort(
                    (left, right) =>
                        Date.parse(right.likedAt) - Date.parse(left.likedAt),
                );
                const requests = newestLiked
                    .filter(isLikedPlaylistTrackDownloadable)
                    .map((likedTrack) => {
                        const track =
                            likedPlaylistTrackToDeviceTrack(likedTrack);
                        return {
                            ownerId,
                            track,
                            sourceUrl: getDeviceDownloadSourceUrl(
                                track as Track,
                            ),
                            quality: "auto",
                            management: "auto-liked" as const,
                            collectionId: "playlist:my-liked",
                            collectionLabel: "Любимые треки",
                        };
                    });
                await queueManager.syncAutoLiked(ownerId, requests);
                if (!isCurrentSession()) return;
                await queueManager.resume(ownerId);
                await loadQueue();
            } while (entry.dirty && isCurrentSession());
        };
        entry.promise = execute().finally(() => {
            if (autoSyncPromises.current.get(ownerId) === entry) {
                autoSyncPromises.current.delete(ownerId);
            }
        });
        autoSyncPromises.current.set(ownerId, entry);
        return entry.promise;
    }, [
        automationSessionGuard,
        loadQueue,
        ownerId,
        queueManager,
        storage.status,
    ]);

    useEffect(() => {
        if (!automationSettings?.autoDownloadLiked) return;
        void syncAutoLiked().catch(() => undefined);
    }, [automationSettings?.autoDownloadLiked, syncAutoLiked]);

    useEffect(
        () =>
            subscribeToDeviceOfflineLikedChanges(() => {
                void syncAutoLiked().catch(() => undefined);
            }),
        [syncAutoLiked],
    );

    useEffect(() => {
        if (
            !automationSettings?.autoDownloadLiked ||
            storage.status !== "ready"
        ) {
            return;
        }
        const requestSync = () => {
            if (
                navigator.onLine === false ||
                document.visibilityState === "hidden"
            ) {
                return;
            }
            void syncAutoLiked().catch(() => undefined);
        };
        const handleVisibility = () => {
            if (document.visibilityState !== "hidden") requestSync();
        };
        window.addEventListener("online", requestSync);
        window.addEventListener("focus", requestSync);
        document.addEventListener("visibilitychange", handleVisibility);
        return () => {
            window.removeEventListener("online", requestSync);
            window.removeEventListener("focus", requestSync);
            document.removeEventListener("visibilitychange", handleVisibility);
        };
    }, [automationSettings?.autoDownloadLiked, storage.status, syncAutoLiked]);

    const download = useCallback(
        async (input: Omit<DeviceOfflineDownloadInput, "ownerId">) => {
            if (!manager || !ownerId)
                throw new Error("Войдите в аккаунт, чтобы скачивать треки");
            await requireManualStorage();
            try {
                return await manager.download({ ...input, ownerId });
            } finally {
                await load(true);
            }
        },
        [load, manager, ownerId, requireManualStorage],
    );

    const resume = useCallback(
        async (record: DeviceOfflineDownloadRecord) => {
            if (record.ownerId !== ownerId) return;
            if (queueManager && ownerId) {
                await requireManualStorage();
                await queueManager.enqueueBatch([
                    {
                        ownerId,
                        track: record.track,
                        quality: record.quality,
                        sourceUrl: record.sourceUrl,
                        management: "manual",
                        collectionId: "retry:device-download",
                        collectionLabel: record.track.title,
                    },
                ]);
                await loadQueue();
                await queueManager.resume(ownerId);
                await load(true);
                return;
            }
            await download({
                track: record.track,
                quality: record.quality,
                sourceUrl: record.sourceUrl,
            });
        },
        [
            download,
            load,
            loadQueue,
            ownerId,
            queueManager,
            requireManualStorage,
        ],
    );

    const deleteDownload = useCallback(
        async (key: string) => {
            if (!manager || !ownerId) return;
            const record = records.find((candidate) => candidate.key === key);
            try {
                if (record && queueManager) {
                    await queueManager.cancelTrack(
                        ownerId,
                        record.trackIdentity,
                        record.quality,
                    );
                } else {
                    await manager.delete(ownerId, key);
                }
            } finally {
                await Promise.all([load(false), loadQueue()]);
            }
        },
        [load, loadQueue, manager, ownerId, queueManager, records],
    );

    const cancelQueuedDownload = useCallback(
        async (item: DeviceOfflineQueueItem) => {
            if (!queueManager || !ownerId || item.ownerId !== ownerId) return;
            try {
                await queueManager.cancelTrack(
                    ownerId,
                    item.trackIdentity,
                    item.quality,
                );
            } finally {
                await Promise.all([load(false), loadQueue()]);
            }
        },
        [load, loadQueue, ownerId, queueManager],
    );

    const preparePlayback = useCallback(
        async (record: DeviceOfflineDownloadRecord) => {
            if (!ownerId || record.ownerId !== ownerId) {
                throw new Error(
                    "Эта копия на устройстве принадлежит другому аккаунту",
                );
            }
            if (record.status !== "ready") {
                throw new Error(
                    "Эта копия на устройстве ещё не готова к воспроизведению",
                );
            }
            // Real device files are acquired as a revocable lease by the
            // player orchestrator. Only legacy CacheStorage records need the
            // eager prepared-source bridge below.
            if (record.mediaRef) return;
            if (hasPreparedDeviceOfflinePlaybackSource(ownerId, record.key)) {
                return;
            }

            try {
                const source =
                    await createBrowserDeviceOfflinePlaybackSource(record);
                if (
                    !prepareDeviceOfflinePlaybackSource(
                        ownerId,
                        record,
                        source.url,
                        source.revoke,
                    )
                ) {
                    throw new Error(
                        "Активный аккаунт изменился до начала воспроизведения",
                    );
                }
            } catch (error) {
                if (manager) {
                    await manager.reconcile(ownerId).catch(() => undefined);
                    await load(false);
                }
                throw error;
            }
        },
        [load, manager, ownerId],
    );

    const exportDownload = useCallback(
        async (record: DeviceOfflineDownloadRecord): Promise<string> => {
            if (
                !vault ||
                !ownerId ||
                !ownerAuthRuntimeLease ||
                record.ownerId !== ownerId
            ) {
                throw new Error(
                    "Эта копия на устройстве принадлежит другому аккаунту",
                );
            }
            if (record.status !== "ready" || !record.mediaRef) {
                throw new Error(
                    "Эта копия на устройстве ещё не готова к сохранению в файл",
                );
            }
            const session = await vault.open({
                ownerId,
                authGeneration: ownerAuthRuntimeLease.generation,
            });
            const exported = await session.access({
                kind: "export",
                ref: record.mediaRef,
                expectedBytes: record.totalBytes,
            });
            startPhysicalFileDownload(exported);
            return exported.displayName;
        },
        [ownerAuthRuntimeLease, ownerId, vault],
    );

    const recordForTrack = useCallback(
        (track: DeviceOfflineTrack) => {
            const identity = resolveDeviceOfflineTrackIdentity(track);
            return (
                records
                    .filter((record) => record.trackIdentity === identity)
                    .sort(
                        (left, right) => right.updatedAt - left.updatedAt,
                    )[0] ?? null
            );
        },
        [records],
    );

    const enqueueCollection = useCallback(
        async (input: DeviceOfflineCollectionDownloadInput) => {
            if (!queueManager || !ownerId) {
                throw new Error("Войдите в аккаунт, чтобы скачивать треки");
            }
            await requireManualStorage();
            const result = await queueManager.enqueueBatch(
                input.tracks.map((track) => ({
                    ownerId,
                    track,
                    sourceUrl: getDeviceDownloadSourceUrl(track),
                    quality: input.quality,
                    management: "manual" as const,
                    collectionId: input.collectionId,
                    collectionLabel: input.collectionLabel,
                })),
            );
            await loadQueue();
            void queueManager
                .resume(ownerId)
                .catch(() => undefined)
                .finally(loadQueue);
            return result;
        },
        [loadQueue, ownerId, queueManager, requireManualStorage],
    );

    const collectionStatus = useCallback(
        (tracks: DeviceOfflineTrack[], quality?: string) =>
            summarizeDeviceOfflineCollection(
                records,
                queueItems,
                tracks,
                quality,
            ),
        [queueItems, records],
    );

    const updateAutomationSettings = useCallback(
        async (
            patch: Partial<
                Pick<
                    DeviceOfflineAutomationSettings,
                    "autoDownloadLiked" | "autoDownloadLikedLimit"
                >
            >,
        ) => {
            if (!queueManager || !ownerId) {
                throw new Error(
                    "Войдите в аккаунт, чтобы настроить загрузки на устройство",
                );
            }
            if (
                patch.autoDownloadLiked === true &&
                storage.status !== "ready"
            ) {
                throw new Error(
                    "Подготовьте офлайн-хранилище, прежде чем включать автоматические загрузки",
                );
            }
            const next = await queueManager.updateSettings(ownerId, patch);
            await loadQueue();
            if (next.autoDownloadLiked) {
                await syncAutoLiked().catch(() => undefined);
            } else if (storage.status === "ready") {
                void queueManager
                    .resume(ownerId)
                    .catch(() => undefined)
                    .finally(loadQueue);
            }
        },
        [loadQueue, ownerId, queueManager, storage.status, syncAutoLiked],
    );

    const retryStorage = useCallback(async () => {
        const [, queueLoaded] = await Promise.all([load(true), loadQueue()]);
        if (
            queueLoaded &&
            queueManager &&
            ownerId &&
            storage.status === "ready"
        ) {
            await queueManager.resume(ownerId).catch(() => undefined);
            await loadQueue();
        }
    }, [load, loadQueue, ownerId, queueManager, storage.status]);

    const value = useMemo<DeviceOfflineContextValue>(
        () => ({
            isHydrated,
            isQueueHydrated,
            storageError,
            storage,
            records,
            queueItems,
            automationSettings,
            capability,
            download,
            resume,
            preparePlayback,
            exportDownload,
            deleteDownload,
            cancelQueuedDownload,
            recordForTrack,
            enqueueCollection,
            collectionStatus,
            updateAutomationSettings,
            setupStorage,
            retryStorage,
            refresh: () => load(false),
        }),
        [
            capability,
            cancelQueuedDownload,
            collectionStatus,
            deleteDownload,
            download,
            enqueueCollection,
            exportDownload,
            isHydrated,
            isQueueHydrated,
            load,
            preparePlayback,
            recordForTrack,
            records,
            queueItems,
            resume,
            retryStorage,
            setupStorage,
            storage,
            storageError,
            automationSettings,
            updateAutomationSettings,
        ],
    );

    return (
        <DeviceOfflineContext.Provider value={value}>
            {children}
        </DeviceOfflineContext.Provider>
    );
}

export function useOptionalDeviceOffline(): DeviceOfflineContextValue | null {
    return useContext(DeviceOfflineContext);
}

export function useDeviceOffline(): DeviceOfflineContextValue {
    const value = useOptionalDeviceOffline();
    if (!value) {
        throw new Error(
            "useDeviceOffline must be used inside DeviceOfflineProvider",
        );
    }
    return value;
}
