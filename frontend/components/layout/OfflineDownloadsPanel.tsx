"use client";

import { useEffect, useState } from "react";
import { DownloadsList } from "@/features/device-offline/components/DownloadsList";
import { Modal } from "@/components/ui/Modal";
import { OPEN_OFFLINE_DOWNLOADS_EVENT } from "./offlineLibraryNavigation";

/** Account-keyed shell layer that keeps local files reachable without navigation. */
export function OfflineDownloadsPanel() {
    const [isOpen, setIsOpen] = useState(false);
    useEffect(() => {
        const open = () => setIsOpen(true);
        window.addEventListener(OPEN_OFFLINE_DOWNLOADS_EVENT, open);
        return () =>
            window.removeEventListener(OPEN_OFFLINE_DOWNLOADS_EVENT, open);
    }, []);

    return (
        <Modal
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            title="Загруженное"
            className="max-w-3xl"
        >
            <p className="mb-5 text-sm text-content-muted">
                Музыка на этом устройстве. Можно слушать без интернета.
            </p>
            <DownloadsList />
        </Modal>
    );
}
