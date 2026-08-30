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
            <div
                className="fixed inset-0 bg-black/80 z-50 "
                onClick={onClose}
            />

            {/* Modal */}
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="bg-[#111] border border-surface-active rounded-lg shadow-2xl max-w-md w-full">
                    {/* Header */}
                    <div className="flex items-center justify-between p-6 border-b border-surface-active">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                                <Check className="w-6 h-6 text-green-500" />
                            </div>
                            <h2 className="text-xl font-semibold text-white">
                                Настройки сохранены
                            </h2>
                        </div>
                        <button
                            onClick={onClose}
                            className="text-gray-400 hover:text-white transition-colors"
                            aria-label={ru.common.close}
                            title={ru.common.close}
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="p-6 space-y-4">
                        <p className="text-gray-300">
                            Настройки сохранены, а файл
                            <code className="text-ai-hover bg-surface px-1.5 py-0.5 rounded mx-1">
                                .env
                            </code>
                            обновлён.
                        </p>

                        {changedServices.length > 0 && (
                            <>
                                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-md p-4">
                                    <p className="text-sm font-medium text-yellow-500 mb-2">
                                        Требуется перезапуск
                                    </p>
                                    <p className="text-sm text-gray-300 mb-3">
                                        Чтобы применить изменения, перезапустите
                                        следующие сервисы:
                                    </p>
                                    <ul className="space-y-1">
                                        {changedServices.map((service) => (
                                            <li
                                                key={service}
                                                className="text-sm text-gray-300 flex items-center gap-2"
                                            >
                                                <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                                                {service}
                                            </li>
                                        ))}
                                    </ul>
                                </div>

                                <div>
                                    <p className="text-sm text-gray-400 mb-2">
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
                                                <Check className="w-4 h-4 text-green-500" />
                                            ) : (
                                                <Copy className="w-4 h-4 text-gray-400" />
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}

                        {changedServices.length === 0 && (
                            <div className="bg-green-500/10 border border-green-500/30 rounded-md p-4">
                                <p className="text-sm text-gray-300">
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
