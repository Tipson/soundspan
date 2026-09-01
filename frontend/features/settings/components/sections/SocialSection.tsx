"use client";

import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { ProfilePictureUpload } from "../ui/ProfilePictureUpload";
import { UserSettings } from "../../types";

interface SocialSectionProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
    onReloadSettings?: () => void;
}

/**
 * Renders the SocialSection component.
 */
export function SocialSection({
    settings,
    onUpdate,
    onReloadSettings,
}: SocialSectionProps) {
    return (
        <SettingsSection id="social" title="Общение">
            <SettingsRow
                label="Фото профиля"
                description="JPEG, PNG или WebP размером не более 512×512"
                align="start"
            >
                <ProfilePictureUpload
                    hasProfilePicture={settings.hasProfilePicture}
                    onChanged={onReloadSettings}
                />
            </SettingsRow>

            <SettingsRow
                label="Показывать, что я в сети"
                description="Ваш профиль будет виден друзьям, пока вы онлайн, в том числе на связанных серверах."
            >
                <SettingsToggle
                    id="share-online-presence"
                    checked={settings.shareOnlinePresence}
                    onChange={(checked) =>
                        onUpdate({ shareOnlinePresence: checked })
                    }
                />
            </SettingsRow>

            <SettingsRow
                label="Показывать, что я слушаю"
                description="Друзья смогут видеть текущий трек, пока вы онлайн."
            >
                <SettingsToggle
                    id="share-listening-status"
                    checked={settings.shareListeningStatus}
                    onChange={(checked) =>
                        onUpdate({ shareListeningStatus: checked })
                    }
                />
            </SettingsRow>
        </SettingsSection>
    );
}
