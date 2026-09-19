"use client";

import { useSyncExternalStore } from "react";

function subscribe(listener: () => void) {
    window.addEventListener("online", listener);
    window.addEventListener("offline", listener);
    return () => {
        window.removeEventListener("online", listener);
        window.removeEventListener("offline", listener);
    };
}

/** Browser connectivity hint, not a claim that the server is reachable. */
export function useNetworkOnline(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => navigator.onLine,
        () => true,
    );
}
