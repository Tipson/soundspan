"use client";

import { ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "./Button";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { ru } from "@/lib/i18n/ru";
import { useDismissibleLayer } from "@/hooks/useDismissibleLayer";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";

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
    useDismissibleLayer(isOpen, onClose);
    useBodyScrollLock(isOpen);
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

    if (!isOpen || typeof document === "undefined") return null;

    return createPortal(
        <div className="fixed inset-0 z-[10010] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-5">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className={cn(
                    "max-h-[min(90dvh,760px)] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-[20px] bg-surface-overlay p-5 shadow-2xl outline-none after:block after:h-[env(safe-area-inset-bottom)] after:shrink-0 after:content-[''] sm:rounded-[16px] sm:p-6 sm:after:hidden",
                    className,
                )}
            >
                {/* Header */}
                <div
                    className={cn(
                        "sticky -top-5 z-10 -mx-5 -mt-5 mb-5 flex items-center justify-between gap-4 bg-surface-overlay px-5 pt-4 pb-3 sm:-top-6 sm:-mx-6 sm:-mt-6 sm:px-6",
                        headerClassName,
                    )}
                >
                    <h2
                        id={titleId}
                        className="min-w-0 break-words text-xl font-semibold text-content"
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
        </div>,
        document.body,
    );
}
