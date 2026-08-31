"use client";

import { useCallback, useMemo, useState } from "react";
import {
    useNotifications,
    type DownloadHistoryItem,
} from "@/hooks/useNotifications";
import { NotificationsTab } from "@/components/activity/NotificationsTab";
import { ActiveDownloadsTab } from "@/components/activity/ActiveDownloadsTab";
import { HistoryTab } from "@/components/activity/HistoryTab";
import { SocialTab } from "@/components/activity/SocialTab";
import { ImportsTab } from "@/components/activity/ImportsTab";
import { useSocialPresence } from "@/hooks/useSocialPresence";
import { useActiveYouTubeDownloads } from "@/hooks/useActiveYouTubeDownloads";
import { youtubeJobToDownloadItem } from "@/lib/youtube-bulk-download";
import { useAuth } from "@/lib/auth-context";
import { useDownloadContext } from "@/lib/download-context";
import {
    getActivityPanelBadgeState,
    getActivityTabBadge,
    getVisibleActivityTabIds,
    isUserFacingActivityNotification,
    resolveActivityTab,
    type ActivityTab,
} from "@/components/layout/activityPanelTabs";
import { Bell, Download, FileInput, History, Users, X } from "lucide-react";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { adminActivityRu } from "@/lib/i18n/adminActivityRu";

const TABS: { id: ActivityTab; label: string; icon: React.ElementType }[] = [
    {
        id: "notifications",
        label: adminActivityRu.activity.tabs.notifications,
        icon: Bell,
    },
    {
        id: "active",
        label: adminActivityRu.activity.tabs.active,
        icon: Download,
    },
    {
        id: "history",
        label: adminActivityRu.activity.tabs.history,
        icon: History,
    },
    {
        id: "imports",
        label: adminActivityRu.activity.tabs.imports,
        icon: FileInput,
    },
    {
        id: "social",
        label: adminActivityRu.activity.tabs.social,
        icon: Users,
    },
];
interface ActivityPanelProps {
    isOpen: boolean;
    onToggle: () => void;
    activeTab?: ActivityTab;
    onTabChange?: (tab: ActivityTab) => void;
}

/**
 * Renders the ActivityPanel component.
 */
export function ActivityPanel({
    isOpen,
    onToggle,
    activeTab,
    onTabChange,
}: ActivityPanelProps) {
    const { user } = useAuth();
    const isAdmin = user?.role === "admin";
    const [internalActiveTab, setInternalActiveTab] =
        useState<ActivityTab>("notifications");
    const resolvedActiveTab = activeTab ?? internalActiveTab;
    const setResolvedActiveTab = onTabChange ?? setInternalActiveTab;
    const visibleTabIds = useMemo(
        () => getVisibleActivityTabIds(isAdmin),
        [isAdmin],
    );
    const visibleTabs = useMemo(
        () => TABS.filter((tab) => visibleTabIds.includes(tab.id)),
        [visibleTabIds],
    );
    const fallbackTab = visibleTabs[0]?.id ?? "notifications";
    const effectiveActiveTab = resolveActivityTab(
        resolvedActiveTab,
        visibleTabIds,
        fallbackTab,
    );
    const { downloadStatus } = useDownloadContext();
    const activeDownloadsForTab = useMemo<DownloadHistoryItem[]>(
        () =>
            downloadStatus.activeDownloads.map((download) => ({
                ...download,
                updatedAt: download.completedAt ?? download.createdAt,
            })),
        [downloadStatus.activeDownloads],
    );
    const pollingEnabled = isOpen;
    const pollingOptions = useMemo(
        () => ({ enabled: pollingEnabled }),
        [pollingEnabled],
    );
    const {
        notifications,
        isLoading: isNotificationsLoading,
        error: notificationsError,
        markAsRead,
        clearNotification,
        clearAll,
    } = useNotifications(pollingOptions);
    const visibleNotifications = useMemo(
        () =>
            (notifications ?? []).filter((notification) =>
                isUserFacingActivityNotification(notification, isAdmin),
            ),
        [isAdmin, notifications],
    );
    const visibleUnreadCount = useMemo(
        () =>
            visibleNotifications.reduce(
                (count, notification) => count + (notification.read ? 0 : 1),
                0,
            ),
        [visibleNotifications],
    );
    const {
        users: socialUsers,
        isLoading: isSocialLoading,
        error: socialError,
    } = useSocialPresence(pollingOptions);
    const {
        jobs: ytDownloadJobs,
        activeCount: ytActiveCount,
        refetch: refetchYtDownloads,
    } = useActiveYouTubeDownloads(pollingOptions);
    // Surface YouTube bulk-download jobs alongside the Soulseek/Lidarr ones so
    // they are visible from any page (not just the search card that started
    // them) and across multiple queued channels.
    const combinedActiveDownloads = useMemo<DownloadHistoryItem[]>(() => {
        const nowIso = new Date().toISOString();
        const ytItems = ytDownloadJobs.map((job) =>
            youtubeJobToDownloadItem(job, nowIso),
        );
        return [...activeDownloadsForTab, ...ytItems];
    }, [activeDownloadsForTab, ytDownloadJobs]);
    const refetchActiveDownloads = useCallback(async () => {
        window.dispatchEvent(new CustomEvent("download-status-changed"));
        await refetchYtDownloads();
    }, [refetchYtDownloads]);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const badgeState = getActivityPanelBadgeState({
        unreadCount: visibleUnreadCount,
        activeDownloadCount:
            downloadStatus.activeDownloads.length + ytActiveCount,
        socialUserCount: socialUsers.length,
        isAdmin,
    });

    // Mobile/Tablet: Full-screen overlay
    if (isMobileOrTablet) {
        if (!isOpen) return null;

        return (
            <>
                {/* Backdrop */}
                <button
                    type="button"
                    aria-label={adminActivityRu.activity.close}
                    className="fixed inset-0 bg-black/60  z-[100]"
                    onClick={onToggle}
                />

                {/* Panel - slides in from right */}
                <div
                    className="fixed inset-y-0 right-0 w-full max-w-md bg-surface z-[101] flex flex-col"
                    style={{ paddingTop: "env(safe-area-inset-top)" }}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
                        <h2 className="text-lg font-semibold text-white">
                            {adminActivityRu.activity.title}
                        </h2>
                        <button
                            onClick={onToggle}
                            className="p-2 hover:bg-white/10 rounded-full transition-colors"
                            title={adminActivityRu.activity.close}
                            aria-label={adminActivityRu.activity.close}
                        >
                            <X className="w-5 h-5 text-white/60" />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="flex border-b border-white/10">
                        {visibleTabs.map((tab) => {
                            const Icon = tab.icon;
                            const badge = getActivityTabBadge(
                                tab.id,
                                badgeState,
                            );

                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setResolvedActiveTab(tab.id)}
                                    className={cn(
                                        "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors relative",
                                        effectiveActiveTab === tab.id
                                            ? "text-white border-b-2 border-brand-hover"
                                            : "text-white/50 hover:text-white/70",
                                    )}
                                >
                                    <Icon className="w-4 h-4" />
                                    <span>{tab.label}</span>
                                    {badge && (
                                        <span
                                            className={cn(
                                                "min-w-[18px] h-[18px] px-1 rounded-full text-xs font-bold flex items-center justify-center ml-1",
                                                tab.id === "active"
                                                    ? "bg-blue-500 text-white"
                                                    : "bg-brand-hover text-black",
                                            )}
                                        >
                                            {badge > 99 ? "99+" : badge}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* Tab Content */}
                    <div className="flex-1 overflow-hidden">
                        {effectiveActiveTab === "notifications" && (
                            <NotificationsTab
                                notifications={visibleNotifications}
                                loading={isNotificationsLoading}
                                error={notificationsError}
                                markAsRead={markAsRead}
                                clearNotification={clearNotification}
                                clearAll={clearAll}
                                queryEnabled={false}
                            />
                        )}
                        {effectiveActiveTab === "active" && (
                            <ActiveDownloadsTab
                                downloads={combinedActiveDownloads}
                                loading={false}
                                refetch={refetchActiveDownloads}
                                queryEnabled={false}
                            />
                        )}
                        {effectiveActiveTab === "history" && <HistoryTab />}
                        {effectiveActiveTab === "imports" && <ImportsTab />}
                        {effectiveActiveTab === "social" && (
                            <SocialTab
                                users={socialUsers}
                                isLoading={isSocialLoading}
                                error={socialError}
                                queryEnabled={false}
                            />
                        )}
                    </div>
                </div>
            </>
        );
    }

    // The top-bar bell owns the closed state. Keeping a collapsed rail here
    // permanently stole content width and made Home reflow whenever Activity
    // was opened, so desktop Activity is an overlay just like mobile.
    if (!isOpen) return null;

    return (
        <aside
            data-activity-panel-layout="overlay"
            aria-label={adminActivityRu.activity.aria}
            className="fixed bottom-[calc(6.5rem+var(--safe-area-bottom))] right-3 top-[4.5rem] z-[90] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface/95 shadow-2xl shadow-black/60 backdrop-blur-xl"
        >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <h2 className="whitespace-nowrap text-base font-semibold text-white">
                    {adminActivityRu.activity.title}
                </h2>
                <button
                    onClick={onToggle}
                    className="grid min-h-11 min-w-11 place-items-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    title={adminActivityRu.activity.close}
                    aria-label={adminActivityRu.activity.close}
                >
                    <X className="h-5 w-5" />
                </button>
            </div>

            <div className="flex gap-1 border-b border-white/10 px-2">
                {visibleTabs.map((tab) => {
                    const Icon = tab.icon;
                    const badge = getActivityTabBadge(tab.id, badgeState);
                    const isActive = effectiveActiveTab === tab.id;

                    return (
                        <button
                            key={tab.id}
                            onClick={() => setResolvedActiveTab(tab.id)}
                            className={cn(
                                "group flex items-center justify-center gap-2 py-3 px-3 transition-all duration-200 relative",
                                isActive
                                    ? "text-white border-b-2 border-brand flex-[2]"
                                    : "text-white/50 hover:text-white/70 hover:flex-[2] flex-1",
                            )}
                            title={tab.label}
                        >
                            <Icon className="w-5 h-5 shrink-0" />
                            <span
                                className={cn(
                                    "text-sm font-medium whitespace-nowrap overflow-hidden transition-all duration-200",
                                    isActive
                                        ? "max-w-[100px] opacity-100"
                                        : "max-w-0 opacity-0 group-hover:max-w-[100px] group-hover:opacity-100",
                                )}
                            >
                                {tab.label}
                            </span>
                            {badge && (
                                <span
                                    className={cn(
                                        "absolute top-1.5 right-1 min-w-[16px] h-[16px] px-0.5 rounded-full text-[10px] font-bold flex items-center justify-center",
                                        tab.id === "active"
                                            ? "bg-blue-500 text-white"
                                            : "bg-brand text-black",
                                    )}
                                >
                                    {badge > 99 ? "99+" : badge}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            <div className="flex-1 overflow-hidden">
                {effectiveActiveTab === "notifications" && (
                    <NotificationsTab
                        notifications={visibleNotifications}
                        loading={isNotificationsLoading}
                        error={notificationsError}
                        markAsRead={markAsRead}
                        clearNotification={clearNotification}
                        clearAll={clearAll}
                        queryEnabled={false}
                    />
                )}
                {effectiveActiveTab === "active" && (
                    <ActiveDownloadsTab
                        downloads={combinedActiveDownloads}
                        loading={false}
                        refetch={refetchActiveDownloads}
                        queryEnabled={false}
                    />
                )}
                {effectiveActiveTab === "history" && <HistoryTab />}
                {effectiveActiveTab === "imports" && <ImportsTab />}
                {effectiveActiveTab === "social" && (
                    <SocialTab
                        users={socialUsers}
                        isLoading={isSocialLoading}
                        error={socialError}
                        queryEnabled={false}
                    />
                )}
            </div>
        </aside>
    );
}

// Toggle button for TopBar
/**
 * Renders the ActivityPanelToggle component.
 */
export function ActivityPanelToggle({
    pollingEnabled = true,
    onToggle,
}: {
    pollingEnabled?: boolean;
    onToggle?: () => void;
} = {}) {
    const { downloadStatus } = useDownloadContext();
    const { user } = useAuth();
    const { notifications } = useNotifications({ enabled: pollingEnabled });
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    if (isMobile || isTablet) {
        return null;
    }

    const unreadCount = (notifications ?? []).filter(
        (notification) =>
            !notification.read &&
            isUserFacingActivityNotification(
                notification,
                user?.role === "admin",
            ),
    ).length;
    const hasActivity =
        unreadCount > 0 || downloadStatus.activeDownloads.length > 0;

    return (
        <button
            onClick={
                onToggle ??
                (() =>
                    window.dispatchEvent(
                        new CustomEvent("toggle-activity-panel"),
                    ))
            }
            className={cn(
                "relative p-2 rounded-full transition-all",
                "text-white/60 hover:text-white",
            )}
            title={adminActivityRu.activity.toggle}
            aria-label={adminActivityRu.activity.toggle}
        >
            <Bell className="w-5 h-5" />
            {hasActivity && (
                <span className="absolute top-1.5 right-2 w-1 h-1 rounded-full bg-brand" />
            )}
        </button>
    );
}
