import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { adminActivityRu } from "@/lib/i18n/adminActivityRu";

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
            title={adminActivityRu.admin.librarySafety.title}
            description={adminActivityRu.admin.librarySafety.description}
        >
            <SettingsRow
                label={adminActivityRu.admin.librarySafety.allowDeletion}
                description={
                    adminActivityRu.admin.librarySafety.allowDeletionDescription
                }
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
