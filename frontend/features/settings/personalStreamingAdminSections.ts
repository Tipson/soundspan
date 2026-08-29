import type { SidebarItem } from "./components/ui";

const PERSONAL_STREAMING_ADMIN_SIDEBAR_ITEMS: SidebarItem[] = [
    { id: "playback-sources", label: "Playback Sources" },
    { id: "youtube-music-admin", label: "YouTube Music" },
    { id: "ai-services", label: "Artwork" },
    { id: "cache", label: "Cache & Automation" },
    { id: "library-safety", label: "Server Library Safety" },
    { id: "users", label: "Users" },
];

/** Returns the deliberately small section list for the personal streaming admin. */
export function getPersonalStreamingAdminSidebarItems(
    federationEnabled: boolean,
): SidebarItem[] {
    return federationEnabled
        ? [
              ...PERSONAL_STREAMING_ADMIN_SIDEBAR_ITEMS,
              { id: "federation", label: "Federation" },
          ]
        : [...PERSONAL_STREAMING_ADMIN_SIDEBAR_ITEMS];
}
