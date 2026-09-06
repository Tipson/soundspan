import { redirect } from "next/navigation";
import { legacyPlaylistsRedirectTarget } from "@/features/playlist/legacyPlaylistsRedirect";

interface LegacyPlaylistsPageProps {
    searchParams: Promise<{
        create?: string | string[];
    }>;
}

/** Keep old bookmarks working while Library owns playlist management. */
export default async function LegacyPlaylistsPage({
    searchParams,
}: LegacyPlaylistsPageProps): Promise<never> {
    const { create } = await searchParams;
    redirect(legacyPlaylistsRedirectTarget(create));
}
