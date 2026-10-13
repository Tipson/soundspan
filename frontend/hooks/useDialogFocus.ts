"use client";

import { useEffect, type RefObject } from "react";
import { nextFocusIndex } from "@/components/ui/focusTrapMath";

const FOCUSABLE_SELECTOR =
    "a:not([tabindex='-1']), button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Contains keyboard focus in an open dialog and restores its connected opener. */
export function useDialogFocus(
    isOpen: boolean,
    dialogRef: RefObject<HTMLElement | null>,
    previouslyFocusedRef: RefObject<HTMLElement | null>,
) {
    useEffect(() => {
        if (!isOpen) return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        previouslyFocusedRef.current =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        const handleTab = (event: KeyboardEvent) => {
            if (event.key !== "Tab") return;
            const elements = Array.from(
                dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
            ).filter(
                (element) =>
                    element.getAttribute("aria-hidden") !== "true" &&
                    !element.closest("[hidden], [inert]"),
            );
            const currentIndex = elements.indexOf(
                document.activeElement as HTMLElement,
            );
            const nextIndex = nextFocusIndex(
                elements.length,
                currentIndex,
                event.shiftKey,
            );
            event.preventDefault();
            if (nextIndex === -1) dialog.focus();
            else elements[nextIndex]?.focus();
        };
        dialog.addEventListener("keydown", handleTab);
        dialog.focus();
        return () => {
            dialog.removeEventListener("keydown", handleTab);
            const previouslyFocused = previouslyFocusedRef.current;
            previouslyFocusedRef.current = null;
            if (previouslyFocused?.isConnected) previouslyFocused.focus();
        };
    }, [dialogRef, isOpen, previouslyFocusedRef]);
}
