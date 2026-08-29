import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";

interface LibrarySafetySectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

/**
 * Renders the LibrarySafetySection component.
 */
export function LibrarySafetySection({
    settings,
    onUpdate,
}: LibrarySafetySectionProps) {
    return (
        <SettingsSection
            id="library-safety"
            title="Server Library Safety"
            description="Keep permanent server-file deletion locked unless you explicitly need it."
        >
            <SettingsRow
                label="Allow permanent album deletion"
                description="Off by default. Enabling this reveals deletion for locally stored albums; the server still validates every request."
                htmlFor="library-deletion-enabled"
            >
                <SettingsToggle
                    id="library-deletion-enabled"
                    checked={settings.libraryDeletionEnabled}
                    onChange={(checked) =>
                        onUpdate({ libraryDeletionEnabled: checked })
                    }
                />
            </SettingsRow>
        </SettingsSection>
    );
}
