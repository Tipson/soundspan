export interface SidebarNavigationItem {
    name: string;
    href: string;
    badge?: string;
    /** Visual accent for special destinations (vibe = brand AI glow). */
    accent?: "vibe";
}

export interface MobileQuickLinkItem {
    name: string;
    href: string;
}

export const SIDEBAR_NAVIGATION: SidebarNavigationItem[] = [
    { name: "Home", href: "/" },
    { name: "Library", href: "/library" },
    { name: "Vibe", href: "/vibe", accent: "vibe" },
];
// No blank line above on purpose (issue #111) — see check-targeted-coverage.mjs.
export const MOBILE_QUICK_LINKS: MobileQuickLinkItem[] = [
    { name: "Home", href: "/" },
    { name: "Library", href: "/library" },
    { name: "Vibe", href: "/vibe" },
];

/**
 * Executes hasMyHistoryLink.
 */
export function hasMyHistoryLink(
    links: ReadonlyArray<{ href: string }>,
): boolean {
    return links.some((link) => link.href === "/my-history");
}
