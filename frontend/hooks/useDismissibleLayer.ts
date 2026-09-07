"use client";

import { useEffect, useRef } from "react";
import { DismissibleLayerHistory } from "@/lib/dismissibleLayerHistory";

let manager: DismissibleLayerHistory | null = null;

function getManager(): DismissibleLayerHistory {
    if (manager) return manager;
    const history = new DismissibleLayerHistory({
        url: () => window.location.href,
        state: () => window.history.state,
        push: (state, url) =>
            window.history.pushState(state, "", url ?? window.location.href),
        back: () => window.history.back(),
    });
    window.addEventListener(
        "popstate",
        (event) => {
            if (history.onPop()) event.stopImmediatePropagation();
        },
        true,
    );
    window.addEventListener(
        "keydown",
        (event) => {
            if (event.key === "Escape" && history.dismiss()) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        },
        true,
    );
    manager = history;
    return history;
}

/** Back/Escape close the highest visible layer without navigating beneath it. */
export function useDismissibleLayer(
    open: boolean,
    onClose: () => void,
    priority = 100,
): void {
    const close = useRef(onClose);
    useEffect(() => {
        close.current = onClose;
    }, [onClose]);
    useEffect(() => {
        if (!open) return;
        return getManager().add(() => close.current(), priority);
    }, [open, priority]);
}
