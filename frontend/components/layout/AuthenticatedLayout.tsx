"use client";

import { useAuth } from "@/lib/auth-context";
import { ru } from "@/lib/i18n/ru";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { TVLayout } from "./TVLayout";
import { BottomNavigation } from "./BottomNavigation";
import { UniversalPlayer } from "../player/UniversalPlayer";
import { MediaControlsHandler } from "../player/MediaControlsHandler";
import { PlayerModeWrapper } from "../player/PlayerModeWrapper";
import { ActivityPanel } from "./ActivityPanel";
import { GradientSpinner } from "../ui/GradientSpinner";
import { PWAInstallPrompt } from "../PWAInstallPrompt";
import { PullToRefresh } from "../ui/PullToRefresh";
import { ReactNode } from "react";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useIsTV } from "@/lib/tv-utils";
import { useActivityPanel } from "@/hooks/useActivityPanel";
import { usePresenceHeartbeat } from "@/hooks/usePresenceHeartbeat";
import { TasteProfileOnboardingGate } from "@/features/taste-profile";

const publicPaths = ["/login", "/register", "/onboarding", "/sync"];
const publicPrefixes = ["/share/"];

/**
 * Renders the AuthenticatedLayout component.
 */
export function AuthenticatedLayout({ children }: { children: ReactNode }) {
    const { isAuthenticated, isLoading, user } = useAuth();
    const pathname = usePathname();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isTV = useIsTV();
    const isMobileOrTablet = isMobile || isTablet;
    const activityPanel = useActivityPanel();
    usePresenceHeartbeat();

    // Listen for activity panel events (toggle/open/close/tab)
    useEffect(() => {
        const handleToggle = () => activityPanel.toggle();
        const handleOpen = () => activityPanel.open();
        const handleClose = () => activityPanel.close();
        const handleSetTab = (
            e: CustomEvent<{
                tab: "notifications" | "active" | "history" | "social";
            }>,
        ) => {
            activityPanel.setActiveTab(e.detail.tab);
        };
        window.addEventListener("toggle-activity-panel", handleToggle);
        window.addEventListener("open-activity-panel", handleOpen);
        window.addEventListener("close-activity-panel", handleClose);
        window.addEventListener(
            "set-activity-panel-tab",
            handleSetTab as EventListener,
        );

        return () => {
            window.removeEventListener("toggle-activity-panel", handleToggle);
            window.removeEventListener("open-activity-panel", handleOpen);
            window.removeEventListener("close-activity-panel", handleClose);
            window.removeEventListener(
                "set-activity-panel-tab",
                handleSetTab as EventListener,
            );
        };
    }, [activityPanel]);

    const isPublicPage =
        publicPaths.includes(pathname) ||
        publicPrefixes.some((prefix) => pathname.startsWith(prefix));

    // Show loading state only on protected pages
    if (!isPublicPage && isLoading) {
        return (
            <div className="min-h-dvh flex items-center justify-center bg-black">
                <div className="flex flex-col items-center gap-4">
                    <GradientSpinner size="lg" />
                    <p className="text-white/60 text-sm">{ru.common.loading}</p>
                </div>
            </div>
        );
    }

    // On public pages (login/register), don't show sidebar/player/topbar
    if (isPublicPage) {
        return <>{children}</>;
    }

    // On protected pages, show appropriate layout based on device
    if (isAuthenticated) {
        const tasteProfileGate = user?.id ? (
            <TasteProfileOnboardingGate key={user.id} accountId={user.id} />
        ) : null;

        // Android TV Layout - Optimized for 10-foot UI
        if (isTV) {
            return (
                <PlayerModeWrapper>
                    <a
                        href="#main-content"
                        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-white focus:text-black focus:rounded-lg focus:font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        {ru.nav.skipToMainContent}
                    </a>
                    {tasteProfileGate}
                    <MediaControlsHandler />
                    <TVLayout>{children}</TVLayout>
                </PlayerModeWrapper>
            );
        }

        // Mobile/Tablet Layout
        if (isMobileOrTablet) {
            return (
                <PlayerModeWrapper>
                    <a
                        href="#main-content"
                        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-white focus:text-black focus:rounded-lg focus:font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        {ru.nav.skipToMainContent}
                    </a>
                    {tasteProfileGate}
                    <div
                        data-shell-frame="mobile"
                        data-shell-direction="spectral-stage"
                        className="mobile-shell-frame h-dvh overflow-hidden"
                        style={{ paddingBottom: 0 }}
                    >
                        <MediaControlsHandler />
                        <TopBar
                            isActivityPanelOpen={activityPanel.isOpen}
                            onActivityPanelToggle={activityPanel.toggle}
                        />

                        {/* Sidebar - renders MobileSidebar for hamburger menu */}
                        <Sidebar />

                        {/* Activity Panel - for mobile notifications (rendered as overlay) */}
                        <ActivityPanel
                            isOpen={activityPanel.isOpen}
                            onToggle={activityPanel.toggle}
                            activeTab={activityPanel.activeTab}
                            onTabChange={activityPanel.setActiveTab}
                        />

                        <PullToRefresh>
                            <main
                                id="main-content"
                                tabIndex={-1}
                                data-app-scroll-container
                                data-shell-surface="content"
                                data-shell-canvas="open"
                                className="mobile-app-stage relative overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                            >
                                <div
                                    data-shell-bottom-inset-owner="content"
                                    className="mobile-stage-content"
                                    style={{
                                        paddingBottom:
                                            "calc(var(--app-mini-player-height) + var(--app-bottom-nav-height) + var(--safe-area-bottom) + 12px)",
                                    }}
                                >
                                    {children}
                                </div>
                            </main>
                        </PullToRefresh>

                        {/* Mini Player - fixed, positioned above bottom nav */}
                        <UniversalPlayer />

                        {/* Bottom Navigation - fixed at bottom */}
                        <BottomNavigation />
                        <PWAInstallPrompt />
                    </div>
                </PlayerModeWrapper>
            );
        }

        // Desktop Layout
        return (
            <PlayerModeWrapper>
                <a
                    href="#main-content"
                    className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-white focus:text-black focus:rounded-lg focus:font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                    {ru.nav.skipToMainContent}
                </a>
                {tasteProfileGate}
                <div
                    data-shell-frame="desktop"
                    data-shell-direction="spectral-stage"
                    className="desktop-shell-frame h-dvh overflow-hidden"
                >
                    <MediaControlsHandler />
                    <div
                        data-shell-workspace="desktop"
                        className="desktop-shell-workspace flex min-h-0 flex-1 overflow-hidden"
                    >
                        <Sidebar />
                        <div
                            data-shell-main-column="desktop"
                            className="desktop-shell-main-column flex min-w-0 flex-1 flex-col overflow-hidden"
                        >
                            <TopBar
                                isActivityPanelOpen={activityPanel.isOpen}
                                onActivityPanelToggle={activityPanel.toggle}
                            />
                            <main
                                id="main-content"
                                tabIndex={-1}
                                data-app-scroll-container
                                data-shell-scroll-mode={
                                    pathname === "/vibe" ? "locked" : "page"
                                }
                                data-shell-surface="content"
                                data-shell-canvas="open"
                                className={`desktop-content-stage relative min-h-0 min-w-0 flex-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${pathname === "/vibe" ? "overflow-hidden" : "overflow-y-auto"}`}
                            >
                                {children}
                            </main>
                        </div>
                        <ActivityPanel
                            isOpen={activityPanel.isOpen}
                            onToggle={activityPanel.toggle}
                            activeTab={activityPanel.activeTab}
                            onTabChange={activityPanel.setActiveTab}
                        />
                    </div>
                    <UniversalPlayer />
                    <PWAInstallPrompt />
                </div>
            </PlayerModeWrapper>
        );
    }

    // If not authenticated on a protected page, auth context will redirect
    return (
        <div className="min-h-dvh flex items-center justify-center bg-black">
            <div className="flex flex-col items-center gap-4">
                <GradientSpinner size="lg" />
                <p className="text-white/60 text-sm">{ru.nav.redirecting}</p>
            </div>
        </div>
    );
}
