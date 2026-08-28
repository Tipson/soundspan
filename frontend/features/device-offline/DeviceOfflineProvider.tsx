"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { useAuth } from "@/lib/auth-context";
import { getBrowserDeviceOfflineManager } from "./browserStorage";
import {
    clearDeviceOfflineRuntimeState,
    setDeviceOfflineRuntimeState,
} from "./playbackResolver";
import {
    resolveBrowserDeviceOfflineTransferCapability,
    resolveDeviceOfflineTransferCapability,
} from "./platform";
import { DeviceOfflineSessionGuard } from "./sessionGuard";
import { resolveDeviceOfflineTrackIdentity } from "./trackIdentity";
import type {
    DeviceOfflineDownloadInput,
    DeviceOfflineDownloadRecord,
    DeviceOfflineTrack,
} from "./types";

export interface DeviceOfflineContextValue {
    isHydrated: boolean;
    records: DeviceOfflineDownloadRecord[];
    capability: ReturnType<typeof resolveDeviceOfflineTransferCapability>;
    download(
        input: Omit<DeviceOfflineDownloadInput, "ownerId">,
    ): Promise<DeviceOfflineDownloadRecord>;
    resume(record: DeviceOfflineDownloadRecord): Promise<void>;
    deleteDownload(key: string): Promise<void>;
    recordForTrack(
        track: DeviceOfflineTrack,
    ): DeviceOfflineDownloadRecord | null;
    refresh(): Promise<void>;
}

const DeviceOfflineContext = createContext<DeviceOfflineContextValue | null>(
    null,
);
const EMPTY_DEVICE_OFFLINE_RECORDS: DeviceOfflineDownloadRecord[] = [];

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
    }>({ ownerId: null, records: [], hydrated: false });
    const records =
        snapshot.ownerId === ownerId
            ? snapshot.records
            : EMPTY_DEVICE_OFFLINE_RECORDS;
    const isHydrated = snapshot.ownerId === ownerId && snapshot.hydrated;
    const [sessionGuard] = useState(
        () => new DeviceOfflineSessionGuard(ownerId),
    );
    const manager = useMemo(
        () =>
            typeof window === "undefined"
                ? null
                : getBrowserDeviceOfflineManager(),
        [],
    );
    const [capability, setCapability] = useState(() =>
        resolveDeviceOfflineTransferCapability({
            userAgent:
                typeof navigator === "undefined" ? "" : navigator.userAgent,
            backgroundFetch: undefined,
        }),
    );

    useEffect(() => {
        if (
            typeof navigator === "undefined" ||
            !("serviceWorker" in navigator)
        ) {
            return;
        }
        let active = true;
        const serviceWorker = navigator.serviceWorker;
        const refreshCapability = () => {
            void resolveBrowserDeviceOfflineTransferCapability().then(
                (nextCapability) => {
                    if (active) setCapability(nextCapability);
                },
                () => undefined,
            );
        };
        refreshCapability();
        serviceWorker.addEventListener("controllerchange", refreshCapability);
        return () => {
            active = false;
            serviceWorker.removeEventListener(
                "controllerchange",
                refreshCapability,
            );
        };
    }, []);

    const load = useCallback(
        async (reconcile: boolean) => {
            const token = sessionGuard.begin(ownerId);
            if (!token) return;
            if (!manager || !ownerId) {
                sessionGuard.publishIfCurrent(token, () => {
                    clearDeviceOfflineRuntimeState();
                    setSnapshot({ ownerId, records: [], hydrated: true });
                });
                return;
            }
            let next: DeviceOfflineDownloadRecord[];
            try {
                next = await manager.list(ownerId);
            } catch {
                sessionGuard.publishIfCurrent(token, () => {
                    clearDeviceOfflineRuntimeState();
                    setSnapshot({ ownerId, records: [], hydrated: true });
                });
                return;
            }
            sessionGuard.publishIfCurrent(token, () => {
                setSnapshot({ ownerId, records: next, hydrated: true });
                setDeviceOfflineRuntimeState(ownerId, next);
            });
            if (!reconcile) return;
            try {
                next = await manager.reconcile(ownerId);
            } catch {
                return;
            }
            sessionGuard.publishIfCurrent(token, () => {
                setSnapshot({ ownerId, records: next, hydrated: true });
                setDeviceOfflineRuntimeState(ownerId, next);
            });
        },
        [manager, ownerId, sessionGuard],
    );

    useEffect(() => {
        sessionGuard.mount(ownerId);
        void load(true);
        return () => {
            sessionGuard.unmount();
            clearDeviceOfflineRuntimeState();
        };
    }, [load, ownerId, sessionGuard]);

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

    const download = useCallback(
        async (input: Omit<DeviceOfflineDownloadInput, "ownerId">) => {
            if (!manager || !ownerId)
                throw new Error("Sign in to download tracks");
            try {
                return await manager.download({ ...input, ownerId });
            } finally {
                await load(true);
            }
        },
        [load, manager, ownerId],
    );

    const resume = useCallback(
        async (record: DeviceOfflineDownloadRecord) => {
            if (record.ownerId !== ownerId) return;
            await download({
                track: record.track,
                quality: record.quality,
                sourceUrl: record.sourceUrl,
            });
        },
        [download, ownerId],
    );

    const deleteDownload = useCallback(
        async (key: string) => {
            if (!manager || !ownerId) return;
            await manager.delete(ownerId, key);
            await load(false);
        },
        [load, manager, ownerId],
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

    const value = useMemo<DeviceOfflineContextValue>(
        () => ({
            isHydrated,
            records,
            capability,
            download,
            resume,
            deleteDownload,
            recordForTrack,
            refresh: () => load(false),
        }),
        [
            capability,
            deleteDownload,
            download,
            isHydrated,
            load,
            recordForTrack,
            records,
            resume,
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
