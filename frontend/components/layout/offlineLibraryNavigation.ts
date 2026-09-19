/** Local shell action: opening downloads must not replace the audio document. */
export const OPEN_OFFLINE_DOWNLOADS_EVENT = "open-device-downloads";

/** Opens the account-scoped local collection without a route or network request. */
export function openOfflineDownloads(): void {
    window.dispatchEvent(new Event(OPEN_OFFLINE_DOWNLOADS_EVENT));
}

/** Keeps offline Library navigation in the live player document. */
export function handleOfflineLibraryNavigation(input: {
    isOnline: boolean;
    isModifiedClick?: boolean;
    preventDefault: () => void;
    openDownloads: () => void;
}): boolean {
    if (input.isOnline || input.isModifiedClick) return false;
    input.preventDefault();
    input.openDownloads();
    return true;
}
