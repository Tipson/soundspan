"use client";

import { useState } from "react";
import {
    Download,
    HardDriveDownload,
    Play,
    RotateCcw,
    Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track } from "@/lib/audio-state-context";
import { useDeviceOffline } from "../DeviceOfflineProvider";
import type { DeviceOfflineQueueItem } from "../offlineQueue";
import type { DeviceOfflineDownloadRecord } from "../types";

function formatBytes(value: number | null): string {
    if (!value || value < 1) return "Size unavailable";
    const units = ["B", "KB", "MB", "GB"];
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit += 1;
    }
    return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function statusCopy(record: DeviceOfflineDownloadRecord): string {
    if (record.status === "ready") return formatBytes(record.totalBytes);
    if (record.status === "downloading") {
        if (record.transferMode === "background") {
            return "Preparing audio — progress starts when it is ready";
        }
        if (record.bytesReceived > 0 && record.totalBytes) {
            const percent = Math.min(
                100,
                Math.floor((record.bytesReceived / record.totalBytes) * 100),
            );
            const suffix =
                percent >= 100
                    ? " — verifying device copy"
                    : " — keep Soundspan open";
            return `Downloading ${percent}% · ${formatBytes(record.bytesReceived)} of ${formatBytes(record.totalBytes)}${suffix}`;
        }
        if (record.bytesReceived > 0) {
            return `Downloading · ${formatBytes(record.bytesReceived)} received · keep Soundspan open`;
        }
        return "Downloading — keep Soundspan open";
    }
    return record.errorMessage ?? "Interrupted — retry restarts this track";
}

function progressPercent(record: DeviceOfflineDownloadRecord): number | null {
    if (
        record.status !== "downloading" ||
        !record.totalBytes ||
        record.totalBytes < 1
    ) {
        return null;
    }
    return Math.min(
        100,
        Math.floor((record.bytesReceived / record.totalBytes) * 100),
    );
}

function isDeviceFileDeleteRecovery(
    record: DeviceOfflineDownloadRecord,
): boolean {
    return (
        record.errorCode === "device_file_delete_pending" ||
        record.errorCode === "device_file_delete_failed"
    );
}

function managementCopy(
    management: DeviceOfflineDownloadRecord["management"],
): string {
    return management === "auto-liked"
        ? "Automatic from Liked songs"
        : "Kept offline manually";
}

function deleteConfirmation(
    title: string,
    management: DeviceOfflineDownloadRecord["management"],
): string {
    const automaticWarning =
        management === "auto-liked"
            ? " This automatic copy may download again while automatic liked-song downloads are enabled."
            : "";
    return `Remove “${title}” only from this device?${automaticWarning} Your Library and copies on other devices will not change.`;
}

function queueStatusCopy(item: DeviceOfflineQueueItem): string {
    if (item.status === "processing") {
        return "Starting device download — keep Soundspan open";
    }
    if (item.status === "error") {
        return item.errorMessage ?? "Device download failed — retry";
    }
    if (item.status === "interrupted") {
        return "Waiting to resume when this device is online";
    }
    return "Queued on this device";
}

export function DownloadsList() {
    const [exportingKey, setExportingKey] = useState<string | null>(null);
    const { playNow } = useAudioControls();
    const {
        isHydrated,
        isQueueHydrated,
        storageError,
        records,
        queueItems,
        capability,
        storage,
        setupStorage,
        cancelQueuedDownload,
        deleteDownload,
        exportDownload,
        preparePlayback,
        resume,
        enqueueCollection,
        retryStorage,
    } = useDeviceOffline();
    const visibleQueueItems = queueItems.filter(
        (item) =>
            !records.some(
                (record) =>
                    record.trackIdentity === item.trackIdentity &&
                    record.quality === item.quality,
            ),
    );
    const reconnectRememberedFolder =
        Boolean(storage.directoryName) &&
        (storage.status === "needs-setup" || storage.status === "error");
    const usesPrivateStorage = storage.storageKind === "browser-private";
    const storageNotice =
        storage.status === "ready" ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/65">
                {usesPrivateStorage ? (
                    <>
                        <span className="font-medium text-white/85">
                            Private Soundspan storage.
                        </span>{" "}
                        {storage.explanation} {capability.explanation}
                    </>
                ) : (
                    <>
                        Device folder:{" "}
                        <span className="font-medium text-white/85">
                            {storage.directoryName ??
                                "selected Soundspan folder"}
                        </span>
                        . {capability.explanation}
                    </>
                )}
            </div>
        ) : (
            <div className="flex flex-col gap-3 rounded-xl border border-warning/25 bg-warning/10 px-4 py-4 text-sm text-content-body sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p className="font-semibold">
                        {storage.status === "unsupported"
                            ? "Device-folder downloads are unavailable"
                            : storage.status === "checking"
                              ? "Checking device storage…"
                              : storage.status === "requesting"
                                ? "Waiting for folder access…"
                                : reconnectRememberedFolder
                                  ? "Reconnect music folder"
                                  : "Choose a music folder"}
                    </p>
                    <p className="mt-1 text-content-muted">
                        {storage.explanation}
                    </p>
                </div>
                {(storage.status === "needs-setup" ||
                    storage.status === "error") && (
                    <button
                        type="button"
                        aria-label={
                            reconnectRememberedFolder
                                ? "Reconnect music folder on this device"
                                : "Choose music folder on this device"
                        }
                        onClick={() => {
                            void setupStorage().catch(() =>
                                toast.error(
                                    "Could not open that folder. Choose it again and allow file access.",
                                ),
                            );
                        }}
                        className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-warning/35 px-4 py-2 font-semibold text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning motion-reduce:transition-none"
                    >
                        {reconnectRememberedFolder
                            ? "Reconnect folder"
                            : "Choose folder"}
                    </button>
                )}
            </div>
        );

    const storageErrorNotice = storageError ? (
        <div
            role="alert"
            className="flex flex-col gap-3 rounded-xl border border-warning/25 bg-warning/10 px-4 py-4 text-sm text-content-body sm:flex-row sm:items-center sm:justify-between"
        >
            <p>{storageError}</p>
            <button
                type="button"
                onClick={() => void retryStorage()}
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-warning/35 px-4 py-2 font-semibold text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning motion-reduce:transition-none"
                aria-label="Retry reading downloads on this device"
            >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Retry
            </button>
        </div>
    ) : null;

    if ((!isHydrated || !isQueueHydrated) && !storageError) {
        return (
            <div className="min-h-[320px] animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />
        );
    }

    if (records.length === 0 && visibleQueueItems.length === 0) {
        if (storageErrorNotice) return storageErrorNotice;
        if (storage.status !== "ready") return storageNotice;
        return (
            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 px-6 text-center">
                <HardDriveDownload className="mb-4 h-10 w-10 text-white/35" />
                <h2 className="text-lg font-semibold text-white">
                    No device downloads
                </h2>
                <p className="mt-2 max-w-md text-sm text-white/50">
                    Open a track menu from Home, Search, or your library and
                    choose Download to this device.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {storageErrorNotice}
            {storageNotice}
            <div className="overflow-hidden rounded-xl border border-white/10">
                {visibleQueueItems.map((item) => (
                    <div
                        key={`queue:${item.key}`}
                        className="flex min-h-16 items-center gap-3 border-b border-white/[0.07] bg-black/20 px-3 py-2 last:border-b-0"
                    >
                        <div
                            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/10 text-white/35"
                            aria-hidden="true"
                        >
                            <HardDriveDownload className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-white">
                                {item.track.title}
                            </p>
                            <p className="truncate text-xs text-white/50">
                                {managementCopy(item.management)} ·{" "}
                                {item.track.artist.name} ·{" "}
                                {queueStatusCopy(item)}
                            </p>
                        </div>
                        {(item.status === "error" ||
                            item.status === "interrupted") && (
                            <button
                                type="button"
                                onClick={() => {
                                    void enqueueCollection({
                                        tracks: [item.track as Track],
                                        collectionId:
                                            item.collectionId ??
                                            `retry:${item.key}`,
                                        collectionLabel:
                                            item.collectionLabel ??
                                            item.track.title,
                                        quality: item.quality,
                                    }).catch(() =>
                                        toast.error(
                                            "Could not retry this download",
                                        ),
                                    );
                                }}
                                className="grid h-11 w-11 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white"
                                aria-label={`Retry ${item.track.title}`}
                                title="Retry download"
                            >
                                <RotateCcw className="h-4 w-4" />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => {
                                if (
                                    !window.confirm(
                                        deleteConfirmation(
                                            item.track.title,
                                            item.management,
                                        ),
                                    )
                                ) {
                                    return;
                                }
                                void cancelQueuedDownload(item).catch(() =>
                                    toast.error(
                                        "Could not remove this device download",
                                    ),
                                );
                            }}
                            className="grid h-11 w-11 place-items-center rounded-full text-white/55 hover:bg-red-500/15 hover:text-red-300"
                            aria-label={`Remove queued device download of ${item.track.title}`}
                            title="Remove from this device"
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </div>
                ))}
                {records.map((record) => {
                    const percent = progressPercent(record);
                    return (
                        <div
                            key={record.key}
                            className="flex min-h-16 items-center gap-3 border-b border-white/[0.07] bg-black/20 px-3 py-2 last:border-b-0"
                        >
                            <button
                                type="button"
                                disabled={record.status !== "ready"}
                                onClick={() => {
                                    void preparePlayback(record)
                                        .then(() =>
                                            playNow({
                                                ...(record.track as Track),
                                            }),
                                        )
                                        .catch(() =>
                                            toast.error(
                                                "This device copy is unavailable. Download it again while online.",
                                            ),
                                        );
                                }}
                                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-black transition hover:brightness-110 disabled:bg-white/10 disabled:text-white/30"
                                aria-label={`Play ${record.track.title}`}
                            >
                                <Play className="h-4 w-4 fill-current" />
                            </button>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-white">
                                    {record.track.title}
                                </p>
                                <p className="truncate text-xs text-white/50">
                                    {managementCopy(record.management)} ·{" "}
                                    {record.track.artist.name} ·{" "}
                                    {statusCopy(record)}
                                </p>
                                {record.status === "downloading" && (
                                    <div
                                        className="mt-1 h-1 overflow-hidden rounded-full bg-white/10"
                                        role="progressbar"
                                        aria-label={`Download progress for ${record.track.title}`}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={percent ?? undefined}
                                    >
                                        <div
                                            className={
                                                percent === null
                                                    ? "h-full w-1/3 animate-pulse rounded-full bg-brand"
                                                    : "h-full rounded-full bg-brand transition-[width]"
                                            }
                                            style={
                                                percent === null
                                                    ? undefined
                                                    : { width: `${percent}%` }
                                            }
                                        />
                                    </div>
                                )}
                            </div>
                            {(record.status === "interrupted" ||
                                record.status === "error") &&
                                !isDeviceFileDeleteRecovery(record) && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            void resume(record).catch(() =>
                                                toast.error(
                                                    "Could not retry this download",
                                                ),
                                            );
                                        }}
                                        className="grid h-11 w-11 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white"
                                        aria-label={`Retry ${record.track.title}`}
                                        title="Retry download"
                                    >
                                        <RotateCcw className="h-4 w-4" />
                                    </button>
                                )}
                            {record.status === "ready" &&
                                Boolean(record.mediaRef) &&
                                usesPrivateStorage && (
                                    <button
                                        type="button"
                                        disabled={exportingKey === record.key}
                                        onClick={() => {
                                            if (exportingKey) return;
                                            setExportingKey(record.key);
                                            void exportDownload(record)
                                                .then((displayName) =>
                                                    toast.success(
                                                        `Save action opened for ${displayName}. Choose a device location if asked.`,
                                                    ),
                                                )
                                                .catch(() =>
                                                    toast.error(
                                                        "Could not open the browser save action for this file.",
                                                    ),
                                                )
                                                .finally(() =>
                                                    setExportingKey(null),
                                                );
                                        }}
                                        className="grid h-11 w-11 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-45"
                                        aria-label={`Save ${record.track.title} as a normal file on this device`}
                                        title="Save as a normal file"
                                    >
                                        <Download
                                            className="h-4 w-4"
                                            aria-hidden="true"
                                        />
                                    </button>
                                )}
                            <button
                                type="button"
                                onClick={() => {
                                    if (
                                        !window.confirm(
                                            deleteConfirmation(
                                                record.track.title,
                                                record.management,
                                            ),
                                        )
                                    ) {
                                        return;
                                    }
                                    void deleteDownload(record.key).catch(() =>
                                        toast.error(
                                            "Could not delete this device copy",
                                        ),
                                    );
                                }}
                                className="grid h-11 w-11 place-items-center rounded-full text-white/55 hover:bg-red-500/15 hover:text-red-300"
                                aria-label={`${isDeviceFileDeleteRecovery(record) ? "Retry deleting" : "Delete device copy of"} ${record.track.title}`}
                                title={
                                    isDeviceFileDeleteRecovery(record)
                                        ? "Retry deleting device copy"
                                        : "Delete device copy"
                                }
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
