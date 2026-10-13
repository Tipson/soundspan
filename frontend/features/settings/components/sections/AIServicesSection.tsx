"use client";

import {
    SettingsSection,
    SettingsRow,
    SettingsInput,
    SettingsToggle,
} from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus } from "@/components/ui/InlineStatus";
import { useConnectionTest } from "@/features/settings/hooks/useConnectionTest";
import { adminActivityRu } from "@/lib/i18n/adminActivityRu";
import { SETTINGS_SECONDARY_BUTTON } from "../ui/settingsFieldStyles";

interface AIServicesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (
        service: string,
    ) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

/**
 * Renders the AIServicesSection component.
 */
export function AIServicesSection({
    settings,
    onUpdate,
    onTest,
    isTesting,
}: AIServicesSectionProps) {
    const {
        status: fanartTestStatus,
        message: fanartTestMessage,
        runTest: runFanartTest,
        reset: resetFanartTest,
    } = useConnectionTest({
        loadingMessage: adminActivityRu.admin.common.testing,
        successMessage: adminActivityRu.admin.common.connected,
        failureMessage: adminActivityRu.admin.common.failed,
    });
    const {
        status: lastfmTestStatus,
        message: lastfmTestMessage,
        runTest: runLastfmTest,
        reset: resetLastfmTest,
    } = useConnectionTest({
        loadingMessage: adminActivityRu.admin.common.testing,
        successMessage: adminActivityRu.admin.common.connected,
        failureMessage: adminActivityRu.admin.common.failed,
    });

    const handleFanartTest = () => runFanartTest(() => onTest("fanart"));

    const handleLastfmTest = () => runLastfmTest(() => onTest("lastfm"));

    return (
        <SettingsSection
            id="ai-services"
            title={adminActivityRu.admin.artwork.title}
            description={adminActivityRu.admin.artwork.description}
        >
            {/* Fanart.tv */}
            <SettingsRow
                label={adminActivityRu.admin.artwork.enableFanart}
                description={adminActivityRu.admin.artwork.fanartDescription}
                htmlFor="fanart-enabled"
            >
                <SettingsToggle
                    id="fanart-enabled"
                    checked={settings.fanartEnabled}
                    onChange={(checked) => onUpdate({ fanartEnabled: checked })}
                />
            </SettingsRow>

            {settings.fanartEnabled && (
                <>
                    <SettingsRow label={adminActivityRu.admin.common.apiKey}>
                        <SettingsInput
                            type="password"
                            value={settings.fanartApiKey}
                            onChange={(v) => onUpdate({ fanartApiKey: v })}
                            placeholder={
                                adminActivityRu.admin.artwork.fanartPlaceholder
                            }
                            className="w-full sm:w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="flex flex-wrap items-center gap-3">
                            <button
                                onClick={handleFanartTest}
                                disabled={isTesting || !settings.fanartApiKey}
                                className={SETTINGS_SECONDARY_BUTTON}
                            >
                                {fanartTestStatus === "loading"
                                    ? adminActivityRu.admin.common.testing
                                    : adminActivityRu.admin.common
                                          .testConnection}
                            </button>
                            <InlineStatus
                                status={fanartTestStatus}
                                message={fanartTestMessage}
                                onClear={resetFanartTest}
                            />
                        </div>
                    </div>
                </>
            )}

            {/* Last.fm */}
            <div className="mt-6 pt-6 border-t border-white/5">
                <div className="mb-4">
                    <p className="text-sm leading-6 text-content-muted">
                        {adminActivityRu.admin.artwork.lastfmHint}
                    </p>
                </div>

                <SettingsRow label={adminActivityRu.admin.artwork.lastfmKey}>
                    <SettingsInput
                        type="password"
                        value={settings.lastfmApiKey || ""}
                        onChange={(v) => onUpdate({ lastfmApiKey: v })}
                        placeholder={
                            adminActivityRu.admin.artwork.lastfmPlaceholder
                        }
                        className="w-full sm:w-64"
                    />
                </SettingsRow>

                {settings.lastfmApiKey && (
                    <div className="pt-2">
                        <div className="flex flex-wrap items-center gap-3">
                            <button
                                onClick={handleLastfmTest}
                                disabled={isTesting}
                                className={SETTINGS_SECONDARY_BUTTON}
                            >
                                {lastfmTestStatus === "loading"
                                    ? adminActivityRu.admin.common.testing
                                    : adminActivityRu.admin.common
                                          .testConnection}
                            </button>
                            <InlineStatus
                                status={lastfmTestStatus}
                                message={lastfmTestMessage}
                                onClear={resetLastfmTest}
                            />
                        </div>
                    </div>
                )}
            </div>
        </SettingsSection>
    );
}
