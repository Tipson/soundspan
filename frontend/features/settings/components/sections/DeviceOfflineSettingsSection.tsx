"use client";

import { useState } from "react";
import { useDeviceOffline } from "@/features/device-offline/DeviceOfflineProvider";
import { DEVICE_OFFLINE_AUTO_LIMIT_OPTIONS } from "@/features/device-offline/offlineQueue";
import {
    SettingsRow,
    SettingsSection,
    SettingsSelect,
    SettingsToggle,
} from "../ui";

const limitOptions = DEVICE_OFFLINE_AUTO_LIMIT_OPTIONS.map((limit) => ({
    value: String(limit),
    label: `${limit} songs`,
}));

/** User-owned controls for liked-song files retained on this device. */
export function DeviceOfflineSettingsSection() {
    const {
        automationSettings,
        isQueueHydrated,
        storageError,
        storage,
        setupStorage,
        retryStorage,
        updateAutomationSettings,
    } = useDeviceOffline();
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const enabled = automationSettings?.autoDownloadLiked ?? false;
    const limit = automationSettings?.autoDownloadLikedLimit ?? 100;
    const baseControlsUnavailable =
        isSaving ||
        !isQueueHydrated ||
        Boolean(storageError) ||
        !automationSettings;
    const toggleUnavailable =
        baseControlsUnavailable || (storage.status !== "ready" && !enabled);
    const limitUnavailable =
        baseControlsUnavailable || storage.status !== "ready";
    const reconnectRememberedFolder =
        Boolean(storage.directoryName) &&
        (storage.status === "needs-setup" || storage.status === "error");
    const usesPrivateStorage = storage.storageKind === "browser-private";

    const chooseStorage = async () => {
        setIsSaving(true);
        setError(null);
        try {
            await setupStorage();
        } catch {
            setError(
                "Soundspan could not open that folder. Choose it again and allow file access.",
            );
        } finally {
            setIsSaving(false);
        }
    };

    const update = async (
        patch:
            | { autoDownloadLiked: boolean }
            | { autoDownloadLikedLimit: number },
    ) => {
        setIsSaving(true);
        setError(null);
        try {
            await updateAutomationSettings(patch);
        } catch {
            setError("Could not update offline settings on this device.");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <SettingsSection
            id="device-offline"
            title="Offline on this device"
            description="Downloads are configured separately on every phone or computer. They are not stored on the Soundspan server and do not automatically appear on another device."
        >
            {storageError && (
                <div
                    role="alert"
                    className="mb-4 flex flex-col gap-3 rounded-xl border border-warning/25 bg-warning/10 p-4 text-sm text-content-body sm:flex-row sm:items-center sm:justify-between"
                >
                    <p>{storageError}</p>
                    <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => {
                            setIsSaving(true);
                            setError(null);
                            void retryStorage().finally(() =>
                                setIsSaving(false),
                            );
                        }}
                        className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-warning/35 px-4 py-2 font-semibold text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
                    >
                        Retry
                    </button>
                </div>
            )}
            {!isQueueHydrated && !storageError && (
                <p
                    className="mb-4 text-sm text-content-muted"
                    aria-live="polite"
                >
                    Loading offline settings on this device…
                </p>
            )}
            <div
                className="mb-4 rounded-xl border border-line-subtle bg-white/[0.03] p-4"
                aria-live="polite"
            >
                {storage.status === "ready" ? (
                    <>
                        <p className="text-sm font-semibold text-content-heading">
                            {usesPrivateStorage
                                ? "Private offline storage ready"
                                : "Device folder ready"}
                        </p>
                        <p className="mt-1 text-sm text-content-muted">
                            {usesPrivateStorage ? (
                                storage.explanation
                            ) : (
                                <>
                                    New downloads will use{" "}
                                    <span className="font-medium text-content-body">
                                        {storage.directoryName ??
                                            "the selected Soundspan folder"}
                                    </span>
                                    .
                                </>
                            )}
                        </p>
                    </>
                ) : (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <p className="text-sm font-semibold text-content-heading">
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
                            <p className="mt-1 text-sm leading-5 text-content-muted">
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
                                disabled={isSaving}
                                onClick={() => void chooseStorage()}
                                className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-brand/40 px-4 py-2 text-sm font-semibold text-brand transition-colors hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
                            >
                                {isSaving
                                    ? "Opening…"
                                    : reconnectRememberedFolder
                                      ? "Reconnect folder"
                                      : "Choose folder"}
                            </button>
                        )}
                    </div>
                )}
            </div>
            <SettingsRow
                htmlFor="device-auto-download-liked"
                label="Automatically download liked songs on this device"
                description="Off by default. After offline storage is ready, Soundspan saves liked songs gradually while the app is open, visible, and online, then resumes later after an interruption."
            >
                <SettingsToggle
                    id="device-auto-download-liked"
                    checked={enabled}
                    disabled={toggleUnavailable}
                    onChange={(checked) =>
                        void update({ autoDownloadLiked: checked })
                    }
                />
            </SettingsRow>
            <SettingsRow
                htmlFor="device-auto-download-limit"
                label="Automatic download limit"
                description="Oldest auto-managed copies are removed first. Tracks you explicitly download are never removed by this limit."
            >
                <SettingsSelect
                    id="device-auto-download-limit"
                    value={String(limit)}
                    disabled={limitUnavailable}
                    options={limitOptions}
                    onChange={(value) =>
                        void update({
                            autoDownloadLikedLimit: Number(value),
                        })
                    }
                />
            </SettingsRow>
            <p className="text-xs leading-5 text-gray-400" aria-live="polite">
                Automatic copies use at most 2 GB in this device&apos;s
                Soundspan storage. A plain PWA cannot download reliably in the
                background; keep Soundspan open until the current transfer
                finishes.
            </p>
            {error && (
                <p className="mt-2 text-xs text-red-400" role="alert">
                    {error}
                </p>
            )}
        </SettingsSection>
    );
}
