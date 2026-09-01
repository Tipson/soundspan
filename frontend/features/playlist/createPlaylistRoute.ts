/** Whether the Playlists route explicitly requests the create dialog. */
export function shouldOpenCreatePlaylist(value: string | null): boolean {
    return value === "1" || value === "true";
}
