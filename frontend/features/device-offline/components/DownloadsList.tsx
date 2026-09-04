"use client";

import { useEffect, useState } from "react";
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
import { ru } from "@/lib/i18n/ru";

function formatBytes(value: number | null): string {
    if (!value || value < 1) return ru.downloads.sizeUnavailable;
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
            return ru.downloads.preparing;
        }
        if (record.bytesReceived > 0 && record.totalBytes) {
            const percent = Math.min(
                100,
                Math.floor((record.bytesReceived / record.totalBytes) * 100),
            );
            const suffix =
                percent >= 100
                    ? " — проверяем копию на устройстве"
                    : ` — ${ru.downloads.keepOpen}`;
            return `${ru.downloads.downloading}: ${percent}% · ${formatBytes(record.bytesReceived)} из ${formatBytes(record.totalBytes)}${suffix}`;
        }
        if (record.bytesReceived > 0) {
            return `${ru.downloads.downloading} · получено ${formatBytes(record.bytesReceived)} · ${ru.downloads.keepOpen}`;
        }
        return `${ru.downloads.downloading} — ${ru.downloads.keepOpen}`;
    }
    if (record.status === "interrupted") {
        if (
            record.errorCode === "device_file_missing" ||
            record.errorCode === "cache_missing"
        ) {
            return "Файл удалён с устройства — скачайте трек снова.";
        }
        if (
            record.errorCode === "device_file_integrity" ||
            record.errorCode === "cache_integrity"
        ) {
            return "Файл повреждён — скачайте трек снова.";
        }
        return `${ru.downloads.interrupted} — ${record.errorMessage ?? "передача остановилась до готовности файла"}. Повтор запустит загрузку трека заново.`;
    }
    return `${ru.downloads.failed} — ${record.errorMessage ?? "копию не удалось сохранить"}. ${ru.downloads.retryTrack}.`;
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
        ? ru.downloads.automaticLiked
        : ru.downloads.keptManually;
}

function deleteConfirmation(
    title: string,
    management: DeviceOfflineDownloadRecord["management"],
): string {
    const automaticWarning =
        management === "auto-liked"
            ? " Автоматическая копия может загрузиться снова, пока включено автоскачивание любимых треков."
            : "";
    return `Удалить «${title}» только с этого устройства?${automaticWarning} Коллекция и копии на других устройствах не изменятся.`;
}

function queueStatusCopy(item: DeviceOfflineQueueItem): string {
    if (item.status === "processing") {
        return ru.downloads.starting;
    }
    if (item.status === "error") {
        return (
            item.errorMessage ??
            `${ru.downloads.failed} — ${ru.common.retry.toLocaleLowerCase()}`
        );
    }
    if (item.status === "interrupted") {
        return ru.downloads.waitingOnline;
    }
    return ru.downloads.queued;
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
        legacyStorage,
        setupStorage,
        setupLegacyStorage,
        cancelQueuedDownload,
        deleteDownload,
        exportDownload,
        preparePlayback,
        resume,
        enqueueCollection,
        retryStorage,
        refresh,
    } = useDeviceOffline();
    useEffect(() => {
        const verify = () => void refresh();
        const verifyWhenVisible = () => {
            if (document.visibilityState === "visible") verify();
        };
        verify();
        window.addEventListener("focus", verify);
        document.addEventListener("visibilitychange", verifyWhenVisible);
        return () => {
            window.removeEventListener("focus", verify);
            document.removeEventListener("visibilitychange", verifyWhenVisible);
        };
    }, [refresh]);
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
    const hasLegacyFolderRecords = records.some((record) =>
        String(record.mediaRef ?? "").startsWith("fsa1:"),
    );
    const legacyFolderNeedsAccess =
        hasLegacyFolderRecords &&
        legacyStorage !== null &&
        legacyStorage.status !== "ready";
    const storageNotice =
        storage.status === "ready" ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/65">
                {usesPrivateStorage ? (
                    <>
                        <span className="font-medium text-white/85">
                            Личное хранилище Soundspan.
                        </span>{" "}
                        {storage.explanation} {capability.explanation}
                    </>
                ) : (
                    <>
                        Папка на устройстве:{" "}
                        <span className="font-medium text-white/85">
                            {storage.directoryName ??
                                "выбранная папка Soundspan"}
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
                            ? ru.downloads.folderUnavailable
                            : storage.status === "checking"
                              ? ru.downloads.checkingStorage
                              : storage.status === "requesting"
                                ? ru.downloads.waitingFolder
                                : reconnectRememberedFolder
                                  ? ru.downloads.reconnectFolder
                                  : ru.downloads.chooseFolder}
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
                                ? ru.downloads.reconnectFolder
                                : ru.downloads.chooseFolder
                        }
                        onClick={() => {
                            void setupStorage().catch(() =>
                                toast.error(ru.downloads.folderError),
                            );
                        }}
                        className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-warning/35 px-4 py-2 font-semibold text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning motion-reduce:transition-none"
                    >
                        {reconnectRememberedFolder
                            ? "Разрешить доступ"
                            : "Выбрать папку"}
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
                aria-label={ru.downloads.retryReading}
            >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {ru.common.retry}
            </button>
        </div>
    ) : null;
    const legacyStorageNotice = legacyFolderNeedsAccess ? (
        <div className="flex flex-col gap-3 rounded-xl border border-warning/25 bg-warning/10 px-4 py-4 text-sm text-content-body sm:flex-row sm:items-center sm:justify-between">
            <div>
                <p className="font-semibold">Откройте прежнюю папку загрузок</p>
                <p className="mt-1 text-content-muted">
                    Новые треки сохраняются внутри Soundspan и больше не
                    попадают в галерею. Доступ к старой папке нужен только для
                    уже загруженных файлов.
                </p>
            </div>
            <button
                type="button"
                onClick={() => {
                    void setupLegacyStorage().catch(() =>
                        toast.error(ru.downloads.folderError),
                    );
                }}
                className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-warning/35 px-4 py-2 font-semibold text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning motion-reduce:transition-none"
            >
                Разрешить доступ
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
                    На этом устройстве нет загрузок
                </h2>
                <p className="mt-2 max-w-md text-sm text-white/50">
                    Откройте меню трека на главной, в поиске или коллекции и
                    выберите «Скачать на это устройство».
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {storageErrorNotice}
            {storageNotice}
            {legacyStorageNotice}
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
                                        toast.error(ru.downloads.retryFailed),
                                    );
                                }}
                                className="grid h-11 w-11 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white"
                                aria-label={`${ru.downloads.retry}: ${item.track.title}`}
                                title={ru.downloads.retry}
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
                                    toast.error(ru.downloads.removeFailed),
                                );
                            }}
                            className="grid h-11 w-11 place-items-center rounded-full text-white/55 hover:bg-red-500/15 hover:text-red-300"
                            aria-label={`${ru.downloads.removeDevice}: ${item.track.title}`}
                            title={ru.downloads.removeDevice}
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
                            data-download-status={record.status}
                            className="flex min-h-16 items-center gap-3 border-b border-white/[0.07] bg-black/20 px-3 py-2 last:border-b-0"
                        >
                            {record.status === "ready" ? (
                                <button
                                    type="button"
                                    onClick={() => {
                                        void preparePlayback(record)
                                            .then(() =>
                                                playNow({
                                                    ...(record.track as Track),
                                                }),
                                            )
                                            .catch(() =>
                                                toast.error(
                                                    ru.downloads
                                                        .unavailableCopy,
                                                ),
                                            );
                                    }}
                                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-black transition hover:brightness-110"
                                    aria-label={`${ru.common.play}: ${record.track.title}`}
                                >
                                    <Play className="h-4 w-4 fill-current" />
                                </button>
                            ) : record.status === "downloading" ? (
                                <button
                                    type="button"
                                    disabled
                                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/10 text-white/30"
                                    aria-label={`${ru.common.play}: ${record.track.title}`}
                                >
                                    <Play className="h-4 w-4 fill-current" />
                                </button>
                            ) : (
                                <div
                                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/10 text-white/30"
                                    aria-hidden="true"
                                >
                                    <HardDriveDownload className="h-4 w-4" />
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-white">
                                    {record.track.title}
                                </p>
                                <p className="truncate text-xs text-white/50">
                                    {managementCopy(record.management)} ·{" "}
                                    {record.track.artist.name}
                                    {record.status === "ready"
                                        ? ` · ${statusCopy(record)}`
                                        : ""}
                                </p>
                                {record.status !== "ready" &&
                                    record.status !== "downloading" && (
                                        <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-warning">
                                            {statusCopy(record)}
                                        </p>
                                    )}
                                {record.status === "downloading" && (
                                    <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-white/65">
                                        {statusCopy(record)}
                                    </p>
                                )}
                                {record.status === "downloading" && (
                                    <div
                                        className="mt-1 h-1 overflow-hidden rounded-full bg-white/10"
                                        role="progressbar"
                                        aria-label={`${ru.downloads.progress}: ${record.track.title}`}
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
                                                    ru.downloads.retryFailed,
                                                ),
                                            );
                                        }}
                                        className="grid h-11 w-11 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white"
                                        aria-label={`${ru.downloads.retry}: ${record.track.title}`}
                                        title={ru.downloads.retry}
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
                                                        `Открыто сохранение файла ${displayName}. При необходимости выберите папку на устройстве.`,
                                                    ),
                                                )
                                                .catch(() =>
                                                    toast.error(
                                                        ru.downloads
                                                            .saveActionFailed,
                                                    ),
                                                )
                                                .finally(() =>
                                                    setExportingKey(null),
                                                );
                                        }}
                                        className="grid h-11 w-11 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-45"
                                        aria-label={`${ru.downloads.saveNormalFile}: ${record.track.title}`}
                                        title={ru.downloads.saveNormalFile}
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
                                        toast.error(ru.downloads.deleteFailed),
                                    );
                                }}
                                className="grid h-11 w-11 place-items-center rounded-full text-white/55 hover:bg-red-500/15 hover:text-red-300"
                                aria-label={`${isDeviceFileDeleteRecovery(record) ? "Повторить удаление" : "Удалить копию с устройства:"} ${record.track.title}`}
                                title={
                                    isDeviceFileDeleteRecovery(record)
                                        ? "Повторить удаление копии с устройства"
                                        : "Удалить копию с устройства"
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
