"use client";

import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { ru } from "@/lib/i18n/ru";

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: "danger" | "warning" | "info";
}

const variantStyles = {
    danger: {
        icon: "text-error",
        iconBg: "bg-error/10",
        confirmButton: "bg-error/15 hover:bg-error/25 text-error",
    },
    warning: {
        icon: "text-warning",
        iconBg: "bg-warning/10",
        confirmButton: "bg-warning hover:bg-warning/85 text-surface",
    },
    info: {
        icon: "text-brand",
        iconBg: "bg-brand/10",
        confirmButton: "bg-brand hover:bg-brand-hover text-surface",
    },
};

/**
 * Renders the ConfirmDialog component.
 */
export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = ru.common.save,
    cancelText = ru.common.cancel,
    variant = "danger",
}: ConfirmDialogProps) {
    const styles = variantStyles[variant];

    const handleConfirm = () => {
        onConfirm();
        onClose();
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            footer={
                <>
                    <button
                        onClick={onClose}
                        className="min-h-11 flex-1 rounded-[var(--music-radius-control)] bg-surface-hover px-4 py-3 font-semibold text-content transition-colors hover:bg-surface-active"
                    >
                        {cancelText}
                    </button>
                    <button
                        onClick={handleConfirm}
                        className={`min-h-11 flex-1 rounded-[var(--music-radius-control)] px-4 py-3 font-semibold transition-colors ${styles.confirmButton}`}
                    >
                        {confirmText}
                    </button>
                </>
            }
        >
            <div className="flex items-start gap-4">
                <div
                    className={`w-12 h-12 rounded-full ${styles.iconBg} flex items-center justify-center flex-shrink-0`}
                >
                    <AlertTriangle className={`w-6 h-6 ${styles.icon}`} />
                </div>
                <p className="min-w-0 flex-1 text-sm leading-6 text-content-secondary">
                    {message}
                </p>
            </div>
        </Modal>
    );
}
