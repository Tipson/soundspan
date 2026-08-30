"use client";

import { SettingsSection } from "../ui";
import { UserSettings } from "../../types";
import { YouTubeMusicCard } from "./YouTubeMusicSection";
import { TidalStreamingCard } from "./TidalStreamingSection";

interface IntegrationsSectionProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
}

/**
 * Renders the IntegrationsSection component.
 */
export function IntegrationsSection({
    settings,
    onUpdate,
}: IntegrationsSectionProps) {
    return (
        <SettingsSection
            id="integrations"
            title="Интеграции"
            description="Подключите внешние музыкальные сервисы для онлайн-воспроизведения"
        >
            <div className="space-y-3">
                <YouTubeMusicCard settings={settings} onUpdate={onUpdate} />
                <TidalStreamingCard settings={settings} onUpdate={onUpdate} />
            </div>
        </SettingsSection>
    );
}
