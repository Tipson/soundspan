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
    { name: ru.nav.home, href: "/" },
    { name: ru.nav.vibe, href: "/vibe", accent: "vibe" },
    { name: ru.nav.library, href: "/library" },
];
// No blank line above on purpose (issue #111) — see check-targeted-coverage.mjs.
export const MOBILE_QUICK_LINKS: MobileQuickLinkItem[] = [
    { name: ru.nav.home, href: "/" },
    { name: ru.nav.vibe, href: "/vibe" },
    { name: ru.nav.library, href: "/library" },
];

/**
 * Executes hasMyHistoryLink.
 */
export function hasMyHistoryLink(
    links: ReadonlyArray<{ href: string }>,
): boolean {
    return links.some((link) => link.href === "/my-history");
}
import { ru } from "@/lib/i18n/ru";
