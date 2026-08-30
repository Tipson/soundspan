"use client";

import { useAuth } from "@/lib/auth-context";
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

const publicPaths = ["/login", "/register", "/onboarding", "/sync"];
const publicPrefixes = ["/share/"];

/**
 * Renders the AuthenticatedLayout component.
 */
export function AuthenticatedLayout({ children }: { children: ReactNode }) {
    const { isAuthenticated, isLoading } = useAuth();
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
                    <p className="text-white/60 text-sm">Loading...</p>
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
        // Android TV Layout - Optimized for 10-foot UI
        if (isTV) {
            return (
                <PlayerModeWrapper>
                    <a
                        href="#main-content"
                        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-white focus:text-black focus:rounded-lg focus:font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        Skip to main content
                    </a>
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
                        Skip to main content
                    </a>
                    <div
                        data-shell-frame="mobile"
                        className="mobile-shell-frame h-dvh overflow-hidden"
                    >
                        <MediaControlsHandler />
                        <TopBar isActivityPanelOpen={activityPanel.isOpen} />

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
                                className="mobile-app-stage relative overflow-y-auto rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                            >
                                <div className="mobile-stage-content">
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
                    Skip to main content
                </a>
                <div
                    data-shell-frame="desktop"
                    className="desktop-shell-frame h-dvh overflow-hidden"
                >
                    <MediaControlsHandler />
                    <TopBar isActivityPanelOpen={activityPanel.isOpen} />
                    <div className="desktop-shell-workspace flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2">
                        <Sidebar />
                        <main
                            id="main-content"
                            tabIndex={-1}
                            data-app-scroll-container
                            data-shell-surface="content"
                            className="desktop-content-stage relative min-w-0 flex-1 overflow-y-auto rounded-[18px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                        >
                            {children}
                        </main>
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
                <p className="text-white/60 text-sm">Redirecting...</p>
            </div>
        </div>
    );
}
