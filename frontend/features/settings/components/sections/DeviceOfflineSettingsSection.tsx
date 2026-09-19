"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useDeviceOffline } from "@/features/device-offline/DeviceOfflineProvider";
import { SettingsRow, SettingsSection, SettingsToggle } from "../ui";
import { ru } from "@/lib/i18n/ru";

/** User-owned controls for liked-song files retained on this device. */
export function DeviceOfflineSettingsSection() {
    const {
        automationSettings,
        automationError,
        retryAutomation,
        records,
        queueItems,
        isQueueHydrated,
        storageError,
        storage,
        setupStorage,
        retryStorage,
        updateAutomationSettings,
    } = useDeviceOffline();
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const enabled = automationSettings?.autoDownloadLiked ?? true;
    const [online, setOnline] = useState(true);
    useEffect(() => {
        const updateNetwork = () => setOnline(navigator.onLine !== false);
        updateNetwork();
        window.addEventListener("online", updateNetwork);
        window.addEventListener("offline", updateNetwork);
        return () => {
            window.removeEventListener("online", updateNetwork);
            window.removeEventListener("offline", updateNetwork);
        };
    }, []);
    const automatic = queueItems.filter(
        (item) => item.management === "auto-liked",
    );
    const pending = automatic.filter((item) => item.status !== "error").length;
    const failures = automatic.filter((item) => item.status === "error");
    const storageBlock = queueItems.find((item) => item.requiresStorageAction);
    const ready = records.filter(
        (record) =>
            record.status === "ready" && record.management === "auto-liked",
    ).length;
    const stateMessage = !enabled
        ? "Автозагрузка приостановлена вами."
        : !online
          ? "Нет подключения к интернету. Загрузка продолжится после подключения."
          : storage.status !== "ready"
            ? "Автозагрузка включена и ждёт доступа к хранилищу."
            : storageBlock
              ? storageBlock.errorMessage
              : automationError
                ? automationError
                : pending > 0
                  ? `Осталось скачать: ${pending}. Сохранено автоматически: ${ready}.`
                  : failures.length > 0
                    ? `Не удалось скачать треков: ${failures.length}. Остальные доступные копии сохранены.`
                    : `Сохранено автоматически: ${ready}. Новые любимые треки скачиваются при открытом Soundspan.`;
    const baseControlsUnavailable =
        isSaving ||
        !isQueueHydrated ||
        Boolean(storageError) ||
        !automationSettings;
    const toggleUnavailable =
        baseControlsUnavailable || (storage.status !== "ready" && !enabled);
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

    const update = async (patch: { autoDownloadLiked: boolean }) => {
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
                description="Включено по умолчанию: сохраняем любимые треки без ограничения количества и объёма со стороны Soundspan. Нужны интернет и свободное место на устройстве."
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
            <div className="rounded-xl border border-line bg-surface-raised p-4">
                <p
                    className="text-sm leading-6 text-content-body"
                    role="status"
                >
                    {stateMessage}
                </p>
                {(automationError || storageBlock || failures.length > 0) && (
                    <button
                        type="button"
                        disabled={
                            isSaving || !online || storage.status !== "ready"
                        }
                        onClick={() => {
                            setIsSaving(true);
                            setError(null);
                            void retryAutomation()
                                .catch(() =>
                                    setError(
                                        "Повторная загрузка не удалась. Проверьте доступ к хранилищу и интернету.",
                                    ),
                                )
                                .finally(() => setIsSaving(false));
                        }}
                        className="mt-3 min-h-11 rounded-full border border-brand/40 px-4 text-sm font-semibold text-brand disabled:opacity-50"
                    >
                        Повторить загрузку
                    </button>
                )}
                <Link
                    href="/library?tab=downloads"
                    className="mt-3 block w-fit text-sm font-semibold text-brand underline underline-offset-4"
                >
                    Открыть загрузки
                </Link>
            </div>
            <p className="text-xs leading-5 text-content-muted">
                Оставьте Soundspan открытым до завершения загрузки. При закрытии
                приложения или потере сети очередь сохраняется. Уже скачанную
                музыку можно слушать без интернета.
            </p>
            {error && (
                <p className="mt-2 text-xs text-red-400" role="alert">
                    {error}
                </p>
            )}
        </SettingsSection>
    );
}
