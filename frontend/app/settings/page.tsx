"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@/lib/auth-context";
import { createFrontendLogger } from "@/lib/logger";
import { useSettingsData } from "@/features/settings/hooks/useSettingsData";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useInlineStatus } from "@/components/ui/InlineStatus";
import { SettingsSaveDock } from "@/features/settings/components/SettingsSaveDock";
import { UserSettingsLayout } from "@/features/settings/components/UserSettingsLayout";
import { ru } from "@/lib/i18n/ru";

// Section components
import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { SignInSecuritySection } from "@/features/settings/components/sections/SignInSecuritySection";
import { SocialSection } from "@/features/settings/components/sections/SocialSection";
import { PlaybackSection } from "@/features/settings/components/sections/PlaybackSection";
import { DeviceOfflineSettingsSection } from "@/features/settings/components/sections/DeviceOfflineSettingsSection";
import { TasteProfileSettingsSection } from "@/features/taste-profile";

function renderSectionFallback() {
    return (
        <div className="flex items-center justify-center py-8">
            <GradientSpinner size="sm" />
        </div>
    );
}

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
    const { user, isAuthenticated, isLoading } = useAuth();
    if (isLoading)
        return (
            <div className="flex min-h-screen items-center justify-center">
                <GradientSpinner size="md" />
            </div>
        );
    if (!isAuthenticated || !user) return null;
    return <UserSettingsForm key={user.id} />;
}

function UserSettingsForm() {
    const { user } = useAuth();
    const [isSaving, setIsSaving] = useState(false);
    const saveStatus = useInlineStatus();

    // User settings hook
    const {
        settings: userSettings,
        hasChanges,
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

    if (userSettingsLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-surface">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <UserSettingsLayout
            sections={{
                profile: (
                    <>
                        <AccountSection
                            settings={userSettings}
                            onUpdate={updateUserSettings}
                        />
                        {user?.id && (
                            <TasteProfileSettingsSection accountId={user.id} />
                        )}
                        <SocialSection
                            settings={userSettings}
                            onUpdate={updateUserSettings}
                            onReloadSettings={() =>
                                reloadUserSettings({ background: true })
                            }
                        />
                    </>
                ),
                playback: (
                    <>
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
                        <PlaybackHistorySection />
                    </>
                ),
                offline: <DeviceOfflineSettingsSection />,
                security: (
                    <>
                        <SignInSecuritySection />
                        <APIKeysSection />
                    </>
                ),
            }}
            saveDock={
                <SettingsSaveDock
                    hasChanges={hasChanges}
                    placement="inline"
                    isSaving={isSaving}
                    status={saveStatus.status}
                    message={saveStatus.message}
                    onStatusClear={saveStatus.reset}
                    onSave={handleSaveAll}
                />
            }
        />
    );
}
