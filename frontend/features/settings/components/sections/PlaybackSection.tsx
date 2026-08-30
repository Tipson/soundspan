"use client";

import {
    SettingsSection,
    SettingsRow,
    SettingsSelect,
    InfoTooltip,
} from "../ui";
import { UserSettings } from "../../types";

interface PlaybackSectionProps {
    value: UserSettings["playbackQuality"];
    onChange: (quality: UserSettings["playbackQuality"]) => void;
    loudnessMode: UserSettings["loudnessMode"];
    onLoudnessModeChange: (mode: UserSettings["loudnessMode"]) => void;
}

const qualityOptions = [
    { value: "original", label: "Оригинал (без потерь)" },
    { value: "high", label: "Высокое (320 кбит/с)" },
    { value: "medium", label: "Среднее (192 кбит/с)" },
    { value: "low", label: "Низкое (128 кбит/с)" },
];

const loudnessOptions = [
    { value: "auto", label: "Автоматически (рекомендуется)" },
    { value: "track", label: "По трекам" },
    { value: "album", label: "По альбомам" },
    { value: "off", label: "Выключено" },
];

/**
 * Renders the PlaybackSection component.
 */
export function PlaybackSection({
    value,
    onChange,
    loudnessMode,
    onLoudnessModeChange,
}: PlaybackSectionProps) {
    return (
        <SettingsSection
            id="playback"
            title="Воспроизведение"
            titleExtra={
                <InfoTooltip text="Здесь настраивается качество локальных файлов из коллекции. Качество YouTube Music и TIDAL задаётся отдельно в разделе интеграций." />
            }
        >
            <SettingsRow
                label="Качество потока"
                description="Чем выше качество, тем больше трафика используется"
            >
                <SettingsSelect
                    value={value}
                    onChange={(v) =>
                        onChange(v as UserSettings["playbackQuality"])
                    }
                    options={qualityOptions}
                />
            </SettingsRow>
            <SettingsRow
                label="Выравнивание громкости"
                description="Сглаживает разницу в громкости. Автоматический режим сохраняет исходную динамику альбомов и выравнивает остальные треки."
            >
                <SettingsSelect
                    value={loudnessMode}
                    onChange={(v) =>
                        onLoudnessModeChange(v as UserSettings["loudnessMode"])
                    }
                    options={loudnessOptions}
                />
            </SettingsRow>
        </SettingsSection>
    );
}
