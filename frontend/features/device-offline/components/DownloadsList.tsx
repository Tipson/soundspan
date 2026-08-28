"use client";

import { HardDriveDownload, Play, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track } from "@/lib/audio-state-context";
import { useDeviceOffline } from "../DeviceOfflineProvider";
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
        return record.transferMode === "background"
            ? "Downloading in browser background"
            : "Downloading — keep soundspan open";
    }
    return record.errorMessage ?? "Interrupted — retry restarts this track";
}

export function DownloadsList() {
    const { playNow } = useAudioControls();
    const { records, capability, deleteDownload, resume } = useDeviceOffline();

    if (records.length === 0) {
        return (
            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 px-6 text-center">
                <HardDriveDownload className="mb-4 h-10 w-10 text-white/35" />
                <h2 className="text-lg font-semibold text-white">
                    No device downloads
                </h2>
                <p className="mt-2 max-w-md text-sm text-white/50">
                    Open a track menu from Home, Search, or your library and
                    choose Download to device.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/65">
                {capability.explanation} Browser storage may still be reclaimed;
                items marked interrupted can be downloaded again.
            </div>
            <div className="overflow-hidden rounded-xl border border-white/10">
                {records.map((record) => (
                    <div
                        key={record.key}
                        className="flex min-h-16 items-center gap-3 border-b border-white/[0.07] bg-black/20 px-3 py-2 last:border-b-0"
                    >
                        <button
                            type="button"
                            disabled={record.status !== "ready"}
                            onClick={() => playNow(record.track as Track)}
                            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-black transition hover:brightness-110 disabled:bg-white/10 disabled:text-white/30"
                            aria-label={`Play ${record.track.title}`}
                        >
                            <Play className="h-4 w-4 fill-current" />
                        </button>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-white">
                                {record.track.title}
                            </p>
                            <p className="truncate text-xs text-white/50">
                                {record.track.artist.name} ·{" "}
                                {statusCopy(record)}
                            </p>
                        </div>
                        {(record.status === "interrupted" ||
                            record.status === "error") && (
                            <button
                                type="button"
                                onClick={() => {
                                    void resume(record).catch(() =>
                                        toast.error(
                                            "Could not retry this download",
                                        ),
                                    );
                                }}
                                className="grid h-10 w-10 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white"
                                aria-label={`Retry ${record.track.title}`}
                                title="Retry download"
                            >
                                <RotateCcw className="h-4 w-4" />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => {
                                void deleteDownload(record.key).catch(() =>
                                    toast.error(
                                        "Could not delete this device copy",
                                    ),
                                );
                            }}
                            className="grid h-10 w-10 place-items-center rounded-full text-white/55 hover:bg-red-500/15 hover:text-red-300"
                            aria-label={`Delete device copy of ${record.track.title}`}
                            title="Delete device copy"
                        >
                            <Trash2 className="h-4 w-4" />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
