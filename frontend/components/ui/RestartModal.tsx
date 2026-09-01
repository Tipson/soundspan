"use client";

import { X, Copy, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "./Button";
import { ru } from "@/lib/i18n/ru";

interface RestartModalProps {
    isOpen: boolean;
    onClose: () => void;
    changedServices: string[];
}

/**
 * Renders the RestartModal component.
 */
export function RestartModal({
    isOpen,
    onClose,
    changedServices,
}: RestartModalProps) {
    const [copied, setCopied] = useState(false);
    const command = "docker-compose restart";

    const handleCopy = async () => {
        await navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <button
                type="button"
                aria-label={ru.common.close}
                className="fixed inset-0 z-50 bg-black/80"
                onClick={onClose}
            />

            {/* Modal */}
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="restart-modal-title"
                className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4"
            >
                <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-line-strong bg-surface shadow-2xl">
                    {/* Header */}
                    <div className="flex items-center justify-between p-6 border-b border-surface-active">
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/20">
                                <Check className="h-6 w-6 text-success" />
                            </div>
                            <h2
                                id="restart-modal-title"
                                className="text-xl font-semibold text-content"
                            >
                                Настройки сохранены
                            </h2>
                        </div>
                        <button
                            onClick={onClose}
                            className="grid min-h-11 min-w-11 place-items-center rounded-full text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
                            aria-label={ru.common.close}
                            title={ru.common.close}
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="p-6 space-y-4">
                        <p className="text-content-secondary">
                            Настройки сохранены, а файл
                            <code className="text-ai-hover bg-surface px-1.5 py-0.5 rounded mx-1">
                                .env
                            </code>
                            обновлён.
                        </p>

                        {changedServices.length > 0 && (
                            <>
                                <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
                                    <p className="mb-2 text-sm font-medium text-warning">
                                        Требуется перезапуск
                                    </p>
                                    <p className="mb-3 text-sm text-content-secondary">
                                        Чтобы применить изменения, перезапустите
                                        следующие сервисы:
                                    </p>
                                    <ul className="space-y-1">
                                        {changedServices.map((service) => (
                                            <li
                                                key={service}
                                                className="flex items-center gap-2 text-sm text-content-secondary"
                                            >
                                                <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                                                {service}
                                            </li>
                                        ))}
                                    </ul>
                                </div>

                                <div>
                                    <p className="mb-2 text-sm text-content-muted">
                                        Выполните команду в терминале:
                                    </p>
                                    <div className="relative">
                                        <div className="bg-surface border border-surface-active rounded-md px-4 py-3 pr-12 font-mono text-sm text-white">
                                            {command}
                                        </div>
                                        <button
                                            onClick={handleCopy}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 hover:bg-surface-hover rounded transition-colors"
                                            title="Скопировать в буфер обмена"
                                        >
                                            {copied ? (
                                                <Check className="h-4 w-4 text-success" />
                                            ) : (
                                                <Copy className="h-4 w-4 text-content-muted" />
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}

                        {changedServices.length === 0 && (
                            <div className="rounded-xl border border-success/30 bg-success/10 p-4">
                                <p className="text-sm text-content-secondary">
                                    Перезапуск не требуется: изменения уже
                                    применены.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-end gap-3 p-6 border-t border-surface-active">
                        {changedServices.length > 0 && (
                            <Button
                                variant="secondary"
                                onClick={handleCopy}
                                className="flex items-center gap-2"
                            >
                                {copied ? (
                                    <>
                                        <Check className="w-4 h-4" />
                                        Скопировано
                                    </>
                                ) : (
                                    <>
                                        <Copy className="w-4 h-4" />
                                        Скопировать команду
                                    </>
                                )}
                            </Button>
                        )}
                        <Button onClick={onClose}>
                            {changedServices.length > 0
                                ? "Перезапущу позже"
                                : ru.common.close}
                        </Button>
                    </div>
                </div>
            </div>
        </>
    );
}
