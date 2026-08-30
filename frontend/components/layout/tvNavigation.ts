export interface TvNavigationItem {
    name: string;
    href: string;
}

export const TV_NAVIGATION: TvNavigationItem[] = [
    { name: "Главная", href: "/" },
    { name: "Поиск", href: "/search" },
    { name: "Медиатека", href: "/library" },
    { name: "Открытия", href: "/discover" },
    { name: "Плейлисты", href: "/playlists" },
];

/**
 * Returns the TV navigation links, omitting the Discovery entry when the
 * discovery feature flag is disabled.
 */
export function getTvNavigation(discoveryEnabled: boolean): TvNavigationItem[] {
    if (discoveryEnabled) {
        return TV_NAVIGATION;
    }
    return TV_NAVIGATION.filter((item) => item.href !== "/discover");
}
