"use client";

import { InlineStatus, type StatusType } from "@/components/ui/InlineStatus";
import { ru } from "@/lib/i18n/ru";

interface SettingsSaveDockProps {
    hasChanges?: boolean;
    placement?: "sticky" | "inline";
    isSaving: boolean;
    status: StatusType;
    message?: string;
    onStatusClear?: () => void;
    onSave: () => void;
}

/** Keeps the settings save result and action clear of fixed player controls. */
export function SettingsSaveDock({
    hasChanges = true,
    placement = "sticky",
    isSaving,
    status,
    message,
    onStatusClear,
    onSave,
}: SettingsSaveDockProps) {
    if (!hasChanges && !isSaving) {
        return status === "idle" ? null : (
            <div className="mt-4" role="status">
                <InlineStatus
                    status={status}
                    message={message}
                    onClear={onStatusClear}
                />
            </div>
        );
    }
    return (
        <div
            data-testid="settings-save-dock"
            className={
                placement === "inline"
                    ? "pt-5"
                    : "sticky bottom-[calc(var(--app-mini-player-height)+var(--app-bottom-nav-height)+var(--safe-area-bottom)+0.75rem)] z-20 pt-4 md:bottom-[calc(var(--app-player-height-desktop)+var(--safe-area-bottom)+1rem)] md:pt-6"
            }
        >
            <div
                data-testid="settings-save-panel"
                className="grid grid-cols-1 gap-2 rounded-2xl border border-white/[0.1] bg-surface-overlay/90 p-2.5 shadow-2xl shadow-black/30 backdrop-blur-xl min-[420px]:grid-cols-[minmax(0,1fr)_auto] min-[420px]:items-center md:grid-cols-[minmax(0,28rem)_auto] md:justify-end"
            >
                <div
                    data-testid="settings-save-status"
                    className="min-h-5 min-w-0 px-2"
                >
                    <InlineStatus
                        status={status}
                        message={message}
                        onClear={onStatusClear}
                        className="max-w-full break-words"
                    />
                </div>
                <button
                    type="button"
                    onClick={onSave}
                    disabled={isSaving}
                    aria-busy={isSaving}
                    className="min-h-11 w-full whitespace-nowrap rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-black shadow-lg shadow-brand/15 transition hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-brand min-[420px]:w-auto motion-reduce:transition-none"
                >
                    {isSaving ? ru.settings.saving : ru.settings.saveChanges}
                </button>
            </div>
        </div>
    );
}
