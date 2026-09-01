import type { SidebarItem } from "./components/ui";
import { adminActivityRu } from "@/lib/i18n/adminActivityRu";

const PERSONAL_STREAMING_ADMIN_SIDEBAR_ITEMS: SidebarItem[] = [
    {
        id: "playback-sources",
        label: adminActivityRu.admin.sidebar.playbackSources,
    },
    {
        id: "youtube-music-admin",
        label: adminActivityRu.admin.sidebar.youtubeMusic,
    },
    { id: "ai-services", label: adminActivityRu.admin.sidebar.artwork },
    {
        id: "cache",
        label: adminActivityRu.admin.sidebar.cacheAutomation,
    },
    {
        id: "library-safety",
        label: adminActivityRu.admin.sidebar.librarySafety,
    },
    { id: "users", label: adminActivityRu.admin.sidebar.users },
];

/** Returns the deliberately small section list for the personal streaming admin. */
export function getPersonalStreamingAdminSidebarItems(
    federationEnabled: boolean,
): SidebarItem[] {
    return federationEnabled
        ? [
              ...PERSONAL_STREAMING_ADMIN_SIDEBAR_ITEMS,
              {
                  id: "federation",
                  label: adminActivityRu.admin.sidebar.federation,
              },
          ]
        : [...PERSONAL_STREAMING_ADMIN_SIDEBAR_ITEMS];
}
