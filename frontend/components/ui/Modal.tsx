"use client";

import { ReactNode, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "./Button";
import { nextFocusIndex } from "./focusTrapMath";
import { ru } from "@/lib/i18n/ru";

const FOCUSABLE_SELECTOR =
    "a:not([tabindex='-1']), button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])";

export interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    footer?: ReactNode;
    className?: string;
    headerClassName?: string;
    contentClassName?: string;
    footerClassName?: string;
}

function useEscapeAndScrollLock(isOpen: boolean, onClose: () => void) {
    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };

        if (isOpen) {
            document.addEventListener("keydown", handleEscape);
            document.body.style.overflow = "hidden";
        }

        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = "unset";
        };
    }, [isOpen, onClose]);
}

function useDialogFocus(
    isOpen: boolean,
    dialogRef: React.RefObject<HTMLDivElement | null>,
    previouslyFocusedRef: React.RefObject<HTMLElement | null>,
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
            if (nextIndex === -1) {
                dialog.focus();
                return;
            }
            elements[nextIndex]?.focus();
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

/**
 * Renders the Modal component.
 */
export function Modal({
    isOpen,
    onClose,
    title,
    children,
    footer,
    className,
    headerClassName,
    contentClassName,
    footerClassName,
}: ModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const previouslyFocusedRef = useRef<HTMLElement | null>(null);
    const titleId = useId();
    useEscapeAndScrollLock(isOpen, onClose);
    useDialogFocus(isOpen, dialogRef, previouslyFocusedRef);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[10010] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-5">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className={cn(
                    "max-h-[min(90dvh,760px)] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-[24px] border border-line bg-surface-overlay p-5 shadow-2xl after:block after:h-[env(safe-area-inset-bottom)] after:shrink-0 after:content-[''] sm:rounded-[24px] sm:p-6 sm:after:hidden",
                    className,
                )}
            >
                {/* Header */}
                <div
                    className={cn(
                        "mb-5 flex items-center justify-between gap-4 border-b border-line pb-4",
                        headerClassName,
                    )}
                >
                    <h2
                        id={titleId}
                        className="text-xl font-semibold text-content"
                    >
                        {title}
                    </h2>
                    <Button
                        variant="icon"
                        onClick={onClose}
                        aria-label={ru.common.close}
                        className="-mr-2"
                    >
                        <X className="w-5 h-5" />
                    </Button>
                </div>

                {/* Content */}
                <div className={cn(footer && "mb-6", contentClassName)}>
                    {children}
                </div>

                {/* Footer */}
                {footer && (
                    <div
                        className={cn(
                            "flex gap-3 justify-end",
                            footerClassName,
                        )}
                    >
                        {footer}
                    </div>
                )}
            </div>
        </div>
    );
}
