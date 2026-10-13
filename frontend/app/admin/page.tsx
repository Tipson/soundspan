"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useAuth } from "@/lib/auth-context";
import { createFrontendLogger } from "@/lib/logger";
import { RestartModal } from "@/components/ui/RestartModal";
import { useSystemSettings } from "@/features/settings/hooks/useSystemSettings";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { EmptyState } from "@/components/ui/EmptyState";
import { useInlineStatus } from "@/components/ui/InlineStatus";
import { SettingsSaveDock } from "@/features/settings/components/SettingsSaveDock";
import { SettingsLayout } from "@/features/settings/components/ui";
import { useFeatures } from "@/lib/features-context";
import { getPersonalStreamingAdminSidebarItems } from "@/features/settings/personalStreamingAdminSections";
import { adminActivityRu } from "@/lib/i18n/adminActivityRu";
import { AlertCircle } from "lucide-react";

function renderSectionFallback() {
    return (
        <div className="flex items-center justify-center py-8">
            <GradientSpinner size="sm" />
        </div>
    );
}

const PlaybackSourcesSection = dynamic(
    () =>
        import("@/features/settings/components/sections/PlaybackSourcesSection").then(
            (mod) => mod.PlaybackSourcesSection,
        ),
    { loading: renderSectionFallback },
);

const YouTubeMusicAdminSection = dynamic(
    () =>
        import("@/features/settings/components/sections/YouTubeMusicSection").then(
            (mod) => mod.YouTubeMusicAdminSection,
        ),
    { loading: renderSectionFallback },
);

const AIServicesSection = dynamic(
    () =>
        import("@/features/settings/components/sections/AIServicesSection").then(
            (mod) => mod.AIServicesSection,
        ),
    { loading: renderSectionFallback },
);

const CacheSection = dynamic(
    () =>
        import("@/features/settings/components/sections/CacheSection").then(
            (mod) => mod.CacheSection,
        ),
    { loading: renderSectionFallback },
);

const LibrarySafetySection = dynamic(
    () =>
        import("@/features/settings/components/sections/LibrarySafetySection").then(
            (mod) => mod.LibrarySafetySection,
        ),
    { loading: renderSectionFallback },
);

const TestApplicationsSection = dynamic(
    () =>
        import("@/features/settings/components/sections/TestApplicationsSection").then(
            (mod) => mod.TestApplicationsSection,
        ),
    { loading: renderSectionFallback },
);

const UserManagementSection = dynamic(
    () =>
        import("@/features/settings/components/sections/UserManagementSection").then(
            (mod) => mod.UserManagementSection,
        ),
    { loading: renderSectionFallback },
);

const FederationSection = dynamic(
    () =>
        import("@/features/settings/components/sections/FederationSection").then(
            (mod) => mod.FederationSection,
        ),
    { loading: renderSectionFallback },
);

const logger = createFrontendLogger("Admin.Page");

/**
 * Renders the AdminPage component.
 */
export default function AdminPage() {
    const { federation } = useFeatures();
    const { isAuthenticated, isLoading: authLoading, user } = useAuth();
    const router = useRouter();
    const [isSaving, setIsSaving] = useState(false);
    const [showRestartModal, setShowRestartModal] = useState(false);
    const [testingServices, setTestingServices] = useState<
        Record<string, boolean>
    >({});
    const saveStatus = useInlineStatus();
    const sidebarItems = useMemo(
        () => getPersonalStreamingAdminSidebarItems(federation),
        [federation],
    );

    const isAdmin = user?.role === "admin";

    const {
        systemSettings,
        isLoading: systemSettingsLoading,
        changedServices,
        updateSystemSettings,
        saveSystemSettings,
        testService,
        loadError: systemSettingsLoadError,
        loadSystemSettings,
    } = useSystemSettings();

    // Redirect non-admins to /settings
    useEffect(() => {
        if (!authLoading && isAuthenticated && !isAdmin) {
            router.replace("/settings");
        }
    }, [authLoading, isAuthenticated, isAdmin, router]);

    // Handle initial hash for section scrolling
    useEffect(() => {
        if (typeof window !== "undefined") {
            const hash = window.location.hash.substring(1);
            if (hash) {
                setTimeout(() => {
                    const element = document.getElementById(hash);
                    if (element) {
                        element.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                        });
                    }
                }, 100);
            }
        }
    }, []);

    const handleSaveAll = useCallback(async () => {
        if (!systemSettings) return;

        setIsSaving(true);
        saveStatus.setLoading();

        try {
            const changedSystemServices =
                (await saveSystemSettings(systemSettings)) || [];
            setIsSaving(false);
            saveStatus.setSuccess(adminActivityRu.admin.saved);
            if (changedSystemServices.length > 0) {
                setShowRestartModal(true);
            }
        } catch (error) {
            logger.error("Failed to save system settings from admin page", {
                error,
            });
            setIsSaving(false);
            saveStatus.setError(adminActivityRu.admin.saveFailed);
        }
    }, [systemSettings, saveSystemSettings, saveStatus]);

    const handleTestService = useCallback(
        async (service: string) => {
            setTestingServices((prev) => ({ ...prev, [service]: true }));
            try {
                return await testService(service);
            } finally {
                setTestingServices((prev) => ({ ...prev, [service]: false }));
            }
        },
        [testService],
    );

    if (authLoading) {
        return <LoadingScreen message={adminActivityRu.admin.loading} />;
    }

    if (!isAuthenticated || !isAdmin) {
        return null;
    }

    if (systemSettingsLoading) {
        return <LoadingScreen message={adminActivityRu.admin.loading} />;
    }

    if (systemSettingsLoadError || !systemSettings) {
        return (
            <div
                data-routed-surface="admin"
                className="min-h-screen bg-surface px-4 py-8"
            >
                <EmptyState
                    icon={<AlertCircle />}
                    title={adminActivityRu.admin.loadFailed}
                    description="Проверьте соединение с сервером и повторите загрузку настроек."
                    action={{
                        label: adminActivityRu.admin.retry,
                        onClick: () => void loadSystemSettings(),
                        variant: "secondary",
                    }}
                />
            </div>
        );
    }

    return (
        <div data-routed-surface="admin" className="min-h-screen bg-surface">
            <SettingsLayout
                sidebarItems={sidebarItems}
                isAdmin={true}
                title={adminActivityRu.admin.title}
                description="Источники музыки, работа сервера и доступ пользователей."
            >
                <PlaybackSourcesSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                />

                <YouTubeMusicAdminSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                />

                <AIServicesSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                    onTest={handleTestService}
                    isTesting={
                        testingServices.openai ||
                        testingServices.fanart ||
                        false
                    }
                />

                <CacheSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                />

                <LibrarySafetySection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                />

                <TestApplicationsSection />
                <UserManagementSection />

                {federation && (
                    <FederationSection
                        settings={systemSettings}
                        onUpdateSettings={updateSystemSettings}
                    />
                )}

                <SettingsSaveDock
                    isSaving={isSaving}
                    status={saveStatus.status}
                    message={saveStatus.message}
                    onStatusClear={saveStatus.reset}
                    onSave={handleSaveAll}
                    saveLabel={adminActivityRu.admin.save}
                    savingLabel={adminActivityRu.admin.saving}
                    idleMessage="Настройки сервера"
                />
            </SettingsLayout>

            <RestartModal
                isOpen={showRestartModal}
                onClose={() => setShowRestartModal(false)}
                changedServices={changedServices}
            />
        </div>
    );
}
