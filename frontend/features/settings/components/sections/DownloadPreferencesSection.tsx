"use client";

import { useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsSelect } from "../ui";
import { DownloadFallback, DownloadSource, SystemSettings } from "../../types";
import {
    countConfiguredSources,
    getConfiguredSources,
    getFallbackOptions,
    getSourceOptions,
    pickAutoSource,
} from "./downloadSourceConfig";

interface DownloadPreferencesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

/**
 * Renders the DownloadPreferencesSection component.
 */
export function DownloadPreferencesSection({
    settings,
    onUpdate,
}: DownloadPreferencesSectionProps) {
    const configured = getConfiguredSources(settings);
    const configuredCount = countConfiguredSources(configured);
    const isDisabled = configuredCount === 0;
    const autoSource = pickAutoSource(configured);

    // Auto-select the only configured service as the download source
    useEffect(() => {
        if (autoSource !== null && settings.downloadSource !== autoSource) {
            onUpdate({ downloadSource: autoSource });
        }
    }, [autoSource, settings.downloadSource, onUpdate]);

    return (
        <SettingsSection
            id="download-preferences"
            title="Загрузки на сервер"
            description="Необязательное сохранение постоянных копий музыки на сервере"
        >
            <SettingsRow
                label="Основной источник загрузок"
                description={
                    isDisabled
                        ? "Сначала настройте хотя бы один сервис загрузок"
                        : "Источник используется только по явному запросу постоянной копии на сервере"
                }
            >
                <SettingsSelect
                    value={settings.downloadSource || "soulseek"}
                    onChange={(v) =>
                        onUpdate({
                            downloadSource: v as DownloadSource,
                            primaryFailureFallback: "none",
                        })
                    }
                    options={getSourceOptions(configured)}
                    disabled={isDisabled}
                />
            </SettingsRow>

            <SettingsRow
                label="Если основной источник недоступен"
                description={
                    isDisabled
                        ? "Сначала настройте хотя бы один сервис загрузок"
                        : "Действие при ошибке загрузки из основного источника"
                }
            >
                <SettingsSelect
                    value={settings.primaryFailureFallback || "none"}
                    onChange={(v) =>
                        onUpdate({
                            primaryFailureFallback: v as DownloadFallback,
                        })
                    }
                    options={getFallbackOptions(
                        configured,
                        settings.downloadSource,
                    )}
                    disabled={isDisabled}
                />
            </SettingsRow>

            <SettingsRow
                label="Одновременные загрузки Soulseek"
                description="Количество параллельных загрузок через Soulseek (от 1 до 10)"
            >
                <SettingsSelect
                    value={
                        settings.soulseekConcurrentDownloads?.toString() || "4"
                    }
                    onChange={(v) =>
                        onUpdate({
                            soulseekConcurrentDownloads: parseInt(v),
                        })
                    }
                    options={[
                        { value: "1", label: "1" },
                        { value: "2", label: "2" },
                        { value: "3", label: "3" },
                        { value: "4", label: "4 (по умолчанию)" },
                        { value: "5", label: "5" },
                        { value: "6", label: "6" },
                        { value: "7", label: "7" },
                        { value: "8", label: "8" },
                        { value: "9", label: "9" },
                        { value: "10", label: "10" },
                    ]}
                    disabled={!configured.soulseek}
                />
            </SettingsRow>
        </SettingsSection>
    );
}
