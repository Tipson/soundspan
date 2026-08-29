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

/** User-owned, browser-local liked-song automation controls. */
export function DeviceOfflineSettingsSection() {
    const {
        automationSettings,
        isQueueHydrated,
        storageError,
        retryStorage,
        updateAutomationSettings,
    } = useDeviceOffline();
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const enabled = automationSettings?.autoDownloadLiked ?? false;
    const limit = automationSettings?.autoDownloadLikedLimit ?? 100;
    const controlsUnavailable =
        isSaving ||
        !isQueueHydrated ||
        Boolean(storageError) ||
        !automationSettings;

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
            description="These controls apply only to this browser or installed PWA. They do not download music to the server or sync file status to another phone."
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
            <SettingsRow
                htmlFor="device-auto-download-liked"
                label="Automatically download liked songs on this device"
                description="Off by default. When enabled, Soundspan saves liked songs gradually while this PWA is open, visible, and online, then resumes later after an interruption."
            >
                <SettingsToggle
                    id="device-auto-download-liked"
                    checked={enabled}
                    disabled={controlsUnavailable}
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
                    disabled={controlsUnavailable}
                    options={limitOptions}
                    onChange={(value) =>
                        void update({
                            autoDownloadLikedLimit: Number(value),
                        })
                    }
                />
            </SettingsRow>
            <p className="text-xs leading-5 text-gray-400" aria-live="polite">
                Automatic copies use at most 2 GB on this device. iPhone and
                iPad continue when you reopen Soundspan; Android also resumes
                when the installed app returns to the foreground.
            </p>
            {error && (
                <p className="mt-2 text-xs text-red-400" role="alert">
                    {error}
                </p>
            )}
        </SettingsSection>
    );
}
