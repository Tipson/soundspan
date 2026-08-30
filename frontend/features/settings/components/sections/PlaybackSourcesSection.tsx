"use client";

import { SettingsSection, SettingsRow, SettingsSelect } from "../ui";
import { SystemSettings } from "../../types";
import { adminActivityRu } from "@/lib/i18n/adminActivityRu";

const DEFAULT_ORDER = "library,peers,tidal,ytmusic";

const orderOptions = [
    {
        value: DEFAULT_ORDER,
        label: `${adminActivityRu.admin.playbackSources.library} → ${adminActivityRu.admin.playbackSources.peers} → TIDAL → YouTube Music (${adminActivityRu.admin.playbackSources.default})`,
    },
    {
        value: "library,peers,ytmusic,tidal",
        label: `${adminActivityRu.admin.playbackSources.library} → ${adminActivityRu.admin.playbackSources.peers} → YouTube Music → TIDAL`,
    },
    {
        value: "library,tidal,ytmusic,peers",
        label: `${adminActivityRu.admin.playbackSources.library} → TIDAL → YouTube Music → ${adminActivityRu.admin.playbackSources.peers}`,
    },
    {
        value: "library,ytmusic,tidal,peers",
        label: `${adminActivityRu.admin.playbackSources.library} → YouTube Music → TIDAL → ${adminActivityRu.admin.playbackSources.peers}`,
    },
];

/** Returns the preset list, appending the stored value when it is custom. */
function resolveOrderOptions(stored: string) {
    if (orderOptions.some((option) => option.value === stored)) {
        return orderOptions;
    }
    return [
        ...orderOptions,
        { value: stored, label: adminActivityRu.admin.playbackSources.custom },
    ];
}

interface PlaybackSourcesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

/**
 * Renders the PlaybackSourcesSection component.
 */
export function PlaybackSourcesSection({
    settings,
    onUpdate,
}: PlaybackSourcesSectionProps) {
    const stored = settings.playbackSourceOrder || DEFAULT_ORDER;

    return (
        <SettingsSection
            id="playback-sources"
            title={adminActivityRu.admin.playbackSources.title}
            description={adminActivityRu.admin.playbackSources.description}
        >
            <SettingsRow
                label={adminActivityRu.admin.playbackSources.priority}
                description={
                    adminActivityRu.admin.playbackSources.priorityDescription
                }
            >
                <SettingsSelect
                    value={stored}
                    onChange={(v) => onUpdate({ playbackSourceOrder: v })}
                    options={resolveOrderOptions(stored)}
                />
            </SettingsRow>
        </SettingsSection>
    );
}
