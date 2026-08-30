export type ActivityTab =
    | "notifications"
    | "active"
    | "history"
    | "imports"
    | "social";

const ALL_ACTIVITY_TAB_IDS: ActivityTab[] = [
    "notifications",
    "active",
    "history",
    "imports",
    "social",
];

export interface ActivityPanelBadgeState {
    notificationBadge: number | null;
    activeBadge: number | null;
    socialBadge: number | null;
    hasActivity: boolean;
}

// Named on purpose (issue #111) instead of an inline multi-line `{ ... }`
// type literal — see check-targeted-coverage.mjs / #111 for why.
export interface GetActivityPanelBadgeStateInput {
    unreadCount: number;
    activeDownloadCount: number;
    socialUserCount: number;
    isAdmin: boolean;
}

export function getActivityPanelBadgeState({
    unreadCount,
    activeDownloadCount,
    socialUserCount,
    isAdmin,
}: GetActivityPanelBadgeStateInput): ActivityPanelBadgeState {
    const notificationBadge = unreadCount > 0 ? unreadCount : null;
    const activeBadge =
        isAdmin && activeDownloadCount > 0 ? activeDownloadCount : null;
    const socialBadge = isAdmin && socialUserCount > 0 ? socialUserCount : null;

    return {
        notificationBadge,
        activeBadge,
        socialBadge,
        hasActivity:
            notificationBadge !== null ||
            activeBadge !== null ||
            socialBadge !== null,
    };
}

/**
 * Executes getActivityTabBadge.
 */
export function getActivityTabBadge(
    tab: ActivityTab,
    badgeState: ActivityPanelBadgeState,
): number | null {
    if (tab === "notifications") {
        return badgeState.notificationBadge;
    }

    if (tab === "active") {
        return badgeState.activeBadge;
    }

    if (tab === "social") {
        return badgeState.socialBadge;
    }

    return null;
}

/**
 * Executes isActivityTabVisible.
 */
export function isActivityTabVisible(
    tab: ActivityTab,
    isAdmin: boolean,
): boolean {
    if (isAdmin) {
        return true;
    }

    return tab === "notifications" || tab === "imports";
}

const TECHNICAL_NOTIFICATION_TITLES = [
    "enrichment complete",
    "enrichment completed with errors",
    "library scan complete",
] as const;

/** Keep library-maintenance noise in Admin while preserving user actions. */
export function isUserFacingActivityNotification(
    notification: { type: string; title: string },
    isAdmin: boolean,
): boolean {
    if (isAdmin) return true;
    const title = notification.title.trim().toLowerCase();
    return !TECHNICAL_NOTIFICATION_TITLES.includes(
        title as (typeof TECHNICAL_NOTIFICATION_TITLES)[number],
    );
}

/**
 * Executes getVisibleActivityTabIds.
 */
export function getVisibleActivityTabIds(isAdmin: boolean): ActivityTab[] {
    return ALL_ACTIVITY_TAB_IDS.filter((tab) =>
        isActivityTabVisible(tab, isAdmin),
    );
}

/**
 * Executes resolveActivityTab.
 */
export function resolveActivityTab(
    requestedTab: ActivityTab,
    visibleTabs: readonly ActivityTab[],
    fallbackTab: ActivityTab = "notifications",
): ActivityTab {
    if (visibleTabs.includes(requestedTab)) {
        return requestedTab;
    }

    return visibleTabs[0] ?? fallbackTab;
}
