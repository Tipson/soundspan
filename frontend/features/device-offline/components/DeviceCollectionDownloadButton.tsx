"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Track } from "@/lib/audio-state-context";
import { cn } from "@/utils/cn";
import { useDeviceOffline } from "../DeviceOfflineProvider";

interface DeviceCollectionDownloadButtonProps {
    tracks: Track[];
    collectionId: string;
    collectionLabel: string;
    className?: string;
}

/** Queue every playable collection track for this browser/PWA only. */
export function DeviceCollectionDownloadButton({
    tracks,
    collectionId,
    collectionLabel,
    className,
}: DeviceCollectionDownloadButtonProps) {
    const { enqueueCollection, collectionStatus } = useDeviceOffline();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const status = collectionStatus(tracks);
    const isReady = status.total > 0 && status.ready === status.total;
    const needsManualProtection = isReady && status.autoReady > 0;
    const isProtected = isReady && !needsManualProtection;
    const isActive = status.queued + status.processing > 0;

    const label = useMemo(() => {
        if (needsManualProtection) return "Keep offline on this device";
        if (isProtected) return "Available offline";
        if (status.errors > 0 && !isActive) {
            return `Retry ${status.errors} failed`;
        }
        if (status.processing > 0 || isSubmitting) {
            return `Saving ${status.ready}/${status.total}`;
        }
        if (status.queued > 0) {
            return `Queued ${status.ready}/${status.total}`;
        }
        return "Download to this device";
    }, [isActive, isProtected, isSubmitting, needsManualProtection, status]);

    if (tracks.length === 0) return null;

    const handleDownload = async () => {
        if (isSubmitting || isProtected || (isActive && status.errors === 0)) {
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
                    ? `${result.queued} tracks queued on this device. Keep Soundspan open while they download.`
                    : needsManualProtection
                      ? "This collection is protected from automatic cleanup on this device."
                      : "This collection is already available offline on this device.",
            );
        } catch {
            toast.error(
                "Could not queue this collection. Reconnect and try again.",
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
    const details = `${status.ready} ready (${status.autoReady} automatic), ${status.queued} queued, ${status.processing} downloading, ${status.errors} failed on this device`;

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={
                    isSubmitting ||
                    isProtected ||
                    (isActive && status.errors === 0)
                }
                aria-label={
                    isProtected
                        ? `${collectionLabel} is available offline on this device`
                        : needsManualProtection
                          ? `Keep ${collectionLabel} offline on this device`
                          : `Download ${collectionLabel} to this device`
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
                {details}
            </span>
        </div>
    );
}
