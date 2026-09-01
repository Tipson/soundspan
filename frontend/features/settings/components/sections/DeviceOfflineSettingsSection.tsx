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
import { pluralRu, ru } from "@/lib/i18n/ru";

const limitOptions = DEVICE_OFFLINE_AUTO_LIMIT_OPTIONS.map((limit) => ({
    value: String(limit),
    label: `${limit} ${pluralRu(limit, ["трек", "трека", "треков"])}`,
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
            setError(ru.downloads.folderError);
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
            setError(
                "Не удалось обновить офлайн-настройки на этом устройстве.",
            );
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <SettingsSection
            id="device-offline"
            title="Офлайн на этом устройстве"
            description="Загрузки настраиваются отдельно на каждом телефоне или компьютере. Они не хранятся на сервере Soundspan и не появляются автоматически на других устройствах."
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
                        Повторить
                    </button>
                </div>
            )}
            {!isQueueHydrated && !storageError && (
                <p
                    className="mb-4 text-sm text-content-muted"
                    aria-live="polite"
                >
                    Загружаем офлайн-настройки этого устройства…
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
                                ? "Личное офлайн-хранилище готово"
                                : "Папка на устройстве готова"}
                        </p>
                        <p className="mt-1 text-sm text-content-muted">
                            {usesPrivateStorage ? (
                                storage.explanation
                            ) : (
                                <>
                                    Новые загрузки будут сохраняться в{" "}
                                    <span className="font-medium text-content-body">
                                        {storage.directoryName ??
                                            "выбранную папку Soundspan"}
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
                                    ? ru.downloads.folderUnavailable
                                    : storage.status === "checking"
                                      ? ru.downloads.checkingStorage
                                      : storage.status === "requesting"
                                        ? ru.downloads.waitingFolder
                                        : reconnectRememberedFolder
                                          ? ru.downloads.reconnectFolder
                                          : ru.downloads.chooseFolder}
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
                                        ? ru.downloads.reconnectFolder
                                        : ru.downloads.chooseFolder
                                }
                                disabled={isSaving}
                                onClick={() => void chooseStorage()}
                                className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-brand/40 px-4 py-2 text-sm font-semibold text-brand transition-colors hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
                            >
                                {isSaving
                                    ? "Открываем…"
                                    : reconnectRememberedFolder
                                      ? "Разрешить доступ"
                                      : "Выбрать папку"}
                            </button>
                        )}
                    </div>
                )}
            </div>
            <SettingsRow
                htmlFor="device-auto-download-liked"
                label="Автоматически скачивать любимые треки на это устройство"
                description="По умолчанию выключено. После настройки хранилища Soundspan постепенно сохраняет любимые треки, пока приложение открыто и устройство в сети, а после прерывания продолжает позже."
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
                label="Лимит автоматических загрузок"
                description="Сначала удаляются самые старые автоматические копии. Треки, которые вы скачали вручную, этот лимит не удаляет."
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
                Автоматические копии занимают не более 2 ГБ в хранилище
                Soundspan на этом устройстве. Обычная PWA не может надёжно
                скачивать в фоне, поэтому не закрывайте Soundspan до завершения
                текущей загрузки.
            </p>
            {error && (
                <p className="mt-2 text-xs text-red-400" role="alert">
                    {error}
                </p>
            )}
        </SettingsSection>
    );
}
