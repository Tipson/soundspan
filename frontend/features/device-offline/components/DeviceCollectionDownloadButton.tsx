"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Track } from "@/lib/audio-state-context";
import { cn } from "@/utils/cn";
import { useDeviceOffline } from "../DeviceOfflineProvider";
import { pluralRu, ru } from "@/lib/i18n/ru";

interface DeviceCollectionDownloadButtonProps {
    tracks: Track[];
    collectionId: string;
    collectionLabel: string;
    className?: string;
}

/** Queue every playable collection track for this device's selected storage. */
export function DeviceCollectionDownloadButton({
    tracks,
    collectionId,
    collectionLabel,
    className,
}: DeviceCollectionDownloadButtonProps) {
    const { enqueueCollection, collectionStatus, storage } = useDeviceOffline();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const status = collectionStatus(tracks);
    const isReady = status.total > 0 && status.ready === status.total;
    const needsManualProtection = isReady && status.autoReady > 0;
    const isProtected = isReady && !needsManualProtection;
    const isActive = status.queued + status.processing > 0;
    const storageUnavailable = storage.status === "unsupported";
    const storageBusy =
        storage.status === "checking" || storage.status === "requesting";

    const label = useMemo(() => {
        if (needsManualProtection) return ru.downloads.keepOffline;
        if (isProtected) return ru.downloads.availableOffline;
        if (status.errors > 0 && !isActive) {
            return `Повторить: ${status.errors} ${pluralRu(status.errors, ["ошибка", "ошибки", "ошибок"])}`;
        }
        if (status.processing > 0 || isSubmitting) {
            return `Сохраняем ${status.ready}/${status.total}`;
        }
        if (status.queued > 0) {
            return `В очереди ${status.ready}/${status.total}`;
        }
        if (storage.status === "needs-setup") {
            return ru.downloads.chooseAndDownload;
        }
        if (storage.status === "error") {
            return ru.downloads.retryFolderAndDownload;
        }
        if (storage.status === "unsupported") {
            return ru.downloads.unavailable;
        }
        return ru.downloads.downloadDevice;
    }, [
        isActive,
        isProtected,
        isSubmitting,
        needsManualProtection,
        status,
        storage.status,
    ]);

    if (tracks.length === 0) return null;

    const handleDownload = async () => {
        if (
            isSubmitting ||
            isProtected ||
            storageUnavailable ||
            storageBusy ||
            (isActive && status.errors === 0)
        ) {
            return;
        }
        setIsSubmitting(true);
        try {
            const result = await enqueueCollection({
                tracks,
                collectionId,
                collectionLabel,
            });
            toast.success(
                result.queued > 0
                    ? `${result.queued} ${pluralRu(result.queued, ["трек добавлен", "трека добавлено", "треков добавлено"])} в очередь на этом устройстве. Не закрывайте Soundspan до завершения загрузки.`
                    : needsManualProtection
                      ? ru.downloads.protected
                      : ru.downloads.alreadyAvailable,
            );
        } catch {
            toast.error(
                storage.status === "needs-setup"
                    ? ru.downloads.chooseFolderHint
                    : ru.downloads.queueFailed,
            );
        } finally {
            setIsSubmitting(false);
        }
    };

    const Icon = isReady
        ? Check
        : status.errors > 0 && !isActive
          ? AlertTriangle
          : isActive || isSubmitting
            ? Loader2
            : Download;
    const details = `${status.ready} готово (${status.autoReady} автоматически), ${status.queued} в очереди, ${status.processing} загружается, ${status.errors} с ошибкой на этом устройстве`;

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={
                    isSubmitting ||
                    isProtected ||
                    storageUnavailable ||
                    storageBusy ||
                    (isActive && status.errors === 0)
                }
                aria-label={
                    isProtected
                        ? `${collectionLabel} доступна офлайн на этом устройстве`
                        : needsManualProtection
                          ? `Хранить ${collectionLabel} офлайн на этом устройстве`
                          : storage.status === "needs-setup"
                            ? `Выбрать папку и скачать ${collectionLabel} на это устройство`
                            : storage.status === "error"
                              ? `Подключить папку заново и скачать ${collectionLabel} на это устройство`
                              : storage.status === "unsupported"
                                ? `${collectionLabel} нельзя скачать в этом браузере`
                                : `Скачать ${collectionLabel} на это устройство`
                }
                aria-describedby={`device-download-status-${collectionId}`}
                className={cn(
                    "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-line-strong px-4 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-default disabled:opacity-70",
                    className,
                )}
            >
                <Icon
                    className={cn(
                        "h-4 w-4 shrink-0",
                        (isActive || isSubmitting) && "animate-spin",
                    )}
                    aria-hidden="true"
                />
                <span>{label}</span>
            </button>
            <span
                id={`device-download-status-${collectionId}`}
                className="sr-only"
                aria-live="polite"
            >
                {details}. {storage.explanation}
            </span>
        </div>
    );
}
