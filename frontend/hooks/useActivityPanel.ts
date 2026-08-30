"use client";

import { useState, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

export type ActivityPanelTab =
    | "notifications"
    | "active"
    | "history"
    | "imports"
    | "social";

export interface UseActivityPanelReturn {
    isOpen: boolean;
    activeTab: ActivityPanelTab;
    setActiveTab: Dispatch<SetStateAction<ActivityPanelTab>>;
    toggle: () => void;
    open: () => void;
    close: () => void;
}

/**
 * Executes useActivityPanel.
 */
export function useActivityPanel(): UseActivityPanelReturn {
    // Activity is an on-demand surface, not persistent workspace chrome.
    // Reopening it on every visit obscures Home and makes a temporary panel
    // look like a permanent part of the layout.
    const [isOpen, setIsOpen] = useState(false);
    const [activeTab, setActiveTab] =
        useState<ActivityPanelTab>("notifications");

    const toggle = useCallback(() => {
        setIsOpen((prev) => !prev);
    }, []);

    const open = useCallback(() => {
        setIsOpen(true);
    }, []);

    const close = useCallback(() => {
        setIsOpen(false);
    }, []);

    return {
        isOpen,
        activeTab,
        setActiveTab,
        toggle,
        open,
        close,
    };
}
