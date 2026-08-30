"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@/lib/auth-context";
import { createFrontendLogger } from "@/lib/logger";
import { useSettingsData } from "@/features/settings/hooks/useSettingsData";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { InlineStatus, useInlineStatus } from "@/components/ui/InlineStatus";
import { SettingsLayout, SidebarItem } from "@/features/settings/components/ui";

// Section components
import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { SignInSecuritySection } from "@/features/settings/components/sections/SignInSecuritySection";
import { SocialSection } from "@/features/settings/components/sections/SocialSection";
import { PlaybackSection } from "@/features/settings/components/sections/PlaybackSection";
import { DeviceOfflineSettingsSection } from "@/features/settings/components/sections/DeviceOfflineSettingsSection";
import { IntegrationsSection } from "@/features/settings/components/sections/IntegrationsSection";

// Define sidebar items
const sidebarItems: SidebarItem[] = [
    { id: "account", label: "Account" },
    { id: "sign-in-security", label: "Sign-in & Security" },
    { id: "social", label: "Social" },
    { id: "history", label: "History & Personalization" },
    { id: "scrobbling", label: "Scrobbling" },
    { id: "playback", label: "Playback" },
    { id: "device-offline", label: "Offline on this device" },
    { id: "integrations", label: "Integrations" },
    { id: "api-keys", label: "API Keys" },
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
    const { isAuthenticated, isLoading: authLoading } = useAuth();
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
            saveStatus.setSuccess("Saved");
        } catch (error) {
            logger.error("Failed to save user settings from settings page", {
                error,
            });
            setIsSaving(false);
            saveStatus.setError("Failed to save");
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

            <SignInSecuritySection />

            {/* Social */}
            <SocialSection
                settings={userSettings}
                onUpdate={updateUserSettings}
                onReloadSettings={() =>
                    reloadUserSettings({ background: true })
                }
            />

            {/* History & Personalization */}
            <PlaybackHistorySection />

            {/* Scrobbling */}
            <ScrobblingSection />

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

            <DeviceOfflineSettingsSection />

            {/* Integrations (YouTube Music + TIDAL — visible to all users) */}
            <IntegrationsSection
                settings={userSettings}
                onUpdate={updateUserSettings}
            />

            {/* API Keys */}
            <APIKeysSection />

            <div className="sticky bottom-3 z-20 pt-4 md:bottom-4 md:pt-6">
                <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/[0.1] bg-surface-overlay/90 p-2.5 shadow-2xl shadow-black/30 backdrop-blur-xl md:justify-end">
                    <div className="min-w-0 flex-1 px-2 md:flex-none">
                        <InlineStatus {...saveStatus.props} />
                    </div>
                    <button
                        onClick={handleSaveAll}
                        disabled={isSaving}
                        className="min-h-11 flex-shrink-0 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-black shadow-lg shadow-brand/15 transition hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-brand"
                    >
                        {isSaving ? "Saving…" : "Save changes"}
                    </button>
                </div>
            </div>
        </SettingsLayout>
    );
}
