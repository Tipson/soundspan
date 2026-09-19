export type LegacyCreateParam = string | string[] | undefined;

/** Preserve old create links while consolidating playlist management in Library. */
export function legacyPlaylistsRedirectTarget(
    create: LegacyCreateParam,
): string {
    const shouldCreate = Array.isArray(create)
        ? create.includes("1")
        : create === "1";
    return shouldCreate
        ? "/library?tab=playlists&create=1"
        : "/library?tab=playlists";
}
