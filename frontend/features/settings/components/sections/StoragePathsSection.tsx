"use client";

import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { SystemSettings } from "../../types";

interface StoragePathsSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (
        service: string,
    ) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

/**
 * Renders the StoragePathsSection component.
 */
export function StoragePathsSection({
    settings,
    onUpdate,
}: StoragePathsSectionProps) {
    return (
        <SettingsSection
            id="storage"
            title="Хранилище"
            description="Пути к музыкальной коллекции на сервере"
        >
            <SettingsRow
                label="Папка музыкальной коллекции"
                description="Путь к музыке на сервере"
            >
                <SettingsInput
                    value={settings.musicPath}
                    onChange={(v) => onUpdate({ musicPath: v })}
                    placeholder="/music"
                    className="w-64"
                />
            </SettingsRow>

            <SettingsRow
                label="Папка загрузок"
                description="Путь для новых загрузок"
            >
                <SettingsInput
                    value={settings.downloadPath}
                    onChange={(v) => onUpdate({ downloadPath: v })}
                    placeholder="/downloads"
                    className="w-64"
                />
            </SettingsRow>
        </SettingsSection>
    );
}
