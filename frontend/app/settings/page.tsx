"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@/lib/auth-context";
import { createFrontendLogger } from "@/lib/logger";
import { useSettingsData } from "@/features/settings/hooks/useSettingsData";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useInlineStatus } from "@/components/ui/InlineStatus";
import { SettingsSaveDock } from "@/features/settings/components/SettingsSaveDock";
import { SettingsLayout, SidebarItem } from "@/features/settings/components/ui";
import { ru } from "@/lib/i18n/ru";

// Section components
import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { SignInSecuritySection } from "@/features/settings/components/sections/SignInSecuritySection";
import { SocialSection } from "@/features/settings/components/sections/SocialSection";
import { PlaybackSection } from "@/features/settings/components/sections/PlaybackSection";
import { DeviceOfflineSettingsSection } from "@/features/settings/components/sections/DeviceOfflineSettingsSection";
import { IntegrationsSection } from "@/features/settings/components/sections/IntegrationsSection";
import { TasteProfileSettingsSection } from "@/features/taste-profile";

// Define sidebar items
const sidebarItems: SidebarItem[] = [
    {
        id: "account",
        label: ru.settings.account,
        groupId: "profile",
        groupLabel: "Профиль",
    },
    {
        id: "taste-profile",
        label: "Музыкальные вкусы",
        groupId: "profile",
        groupLabel: "Профиль",
    },
    {
        id: "social",
        label: ru.settings.social,
        groupId: "profile",
        groupLabel: "Профиль",
    },
    {
        id: "sign-in-security",
        label: ru.settings.security,
        groupId: "security",
        groupLabel: "Безопасность",
    },
    {
        id: "api-keys",
        label: ru.settings.apiKeys,
        groupId: "security",
        groupLabel: "Безопасность",
    },
    {
        id: "playback",
        label: ru.settings.playback,
        groupId: "listening",
        groupLabel: "Прослушивание",
    },
    {
        id: "history",
        label: ru.settings.history,
        groupId: "listening",
        groupLabel: "Прослушивание",
    },
    {
        id: "scrobbling",
        label: ru.settings.scrobbling,
        groupId: "listening",
        groupLabel: "Прослушивание",
    },
    {
        id: "device-offline",
        label: ru.settings.offlineDevice,
        groupId: "offline",
        groupLabel: "Офлайн",
    },
    {
        id: "integrations",
        label: ru.settings.integrations,
        groupId: "services",
        groupLabel: "Сервисы",
    },
];

function renderSectionFallback() {
    return (
        <div className="flex items-center justify-center py-8">
            <GradientSpinner size="sm" />
        </div>
    );
}

const ScrobblingSection = dynamic(
    () =>
        import("@/features/settings/components/sections/ScrobblingSection").then(
            (mod) => mod.ScrobblingSection,
        ),
    { loading: renderSectionFallback },
);

const PlaybackHistorySection = dynamic(
    () =>
        import("@/features/settings/components/sections/PlaybackHistorySection").then(
            (mod) => mod.PlaybackHistorySection,
        ),
    { loading: renderSectionFallback },
);

const APIKeysSection = dynamic(
    () =>
        import("@/features/settings/components/sections/APIKeysSection").then(
            (mod) => mod.APIKeysSection,
        ),
    { loading: renderSectionFallback },
);

const logger = createFrontendLogger("Settings.Page");

/**
 * Renders the SettingsPage component.
 */
export default function SettingsPage() {
    const { user, isAuthenticated, isLoading: authLoading } = useAuth();
    const [isSaving, setIsSaving] = useState(false);
    const saveStatus = useInlineStatus();

    // User settings hook
    const {
        settings: userSettings,
        isLoading: userSettingsLoading,
        updateSettings: updateUserSettings,
        saveSettings: saveUserSettings,
        loadSettings: reloadUserSettings,
    } = useSettingsData();

    const handleSaveAll = useCallback(async () => {
        setIsSaving(true);
        saveStatus.setLoading();

        try {
            await saveUserSettings(userSettings);
            setIsSaving(false);
            saveStatus.setSuccess(ru.settings.saved);
        } catch (error) {
            logger.error("Failed to save user settings from settings page", {
                error,
            });
            setIsSaving(false);
            saveStatus.setError(ru.settings.saveFailed);
        }
    }, [userSettings, saveUserSettings, saveStatus]);

    if (authLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-surface">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    if (userSettingsLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-surface">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <SettingsLayout sidebarItems={sidebarItems} isAdmin={false}>
            {/* Account (includes Subsonic app password) */}
            <AccountSection
                settings={userSettings}
                onUpdate={updateUserSettings}
            />

            {user?.id && <TasteProfileSettingsSection accountId={user.id} />}

            {/* Social */}
            <SocialSection
                settings={userSettings}
                onUpdate={updateUserSettings}
                onReloadSettings={() =>
                    reloadUserSettings({ background: true })
                }
            />

            <SignInSecuritySection />

            {/* API Keys */}
            <APIKeysSection />

            {/* Playback */}
            <PlaybackSection
                value={userSettings.playbackQuality}
                onChange={(quality) =>
                    updateUserSettings({ playbackQuality: quality })
                }
                loudnessMode={userSettings.loudnessMode}
                onLoudnessModeChange={(mode) =>
                    updateUserSettings({ loudnessMode: mode })
                }
            />

            {/* History & Personalization */}
            <PlaybackHistorySection />

            {/* Scrobbling */}
            <ScrobblingSection />

            <DeviceOfflineSettingsSection />

            {/* Optional YouTube Music account linking. */}
            <IntegrationsSection
                settings={userSettings}
                onUpdate={updateUserSettings}
            />

            <SettingsSaveDock
                isSaving={isSaving}
                status={saveStatus.status}
                message={saveStatus.message}
                onStatusClear={saveStatus.reset}
                onSave={handleSaveAll}
            />
        </SettingsLayout>
    );
}
