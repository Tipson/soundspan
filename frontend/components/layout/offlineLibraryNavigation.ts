const OFFLINE_DOWNLOADS_PATH = "/library?tab=downloads";

export function handleOfflineLibraryNavigation(input: {
    isOnline: boolean;
    preventDefault: () => void;
    hardNavigate: (path: string) => void;
}): boolean {
    if (input.isOnline) return false;
    input.preventDefault();
    input.hardNavigate(OFFLINE_DOWNLOADS_PATH);
    return true;
}
