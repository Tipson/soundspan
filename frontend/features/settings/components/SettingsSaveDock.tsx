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
    saveLabel?: string;
    savingLabel?: string;
    idleMessage?: string;
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
    saveLabel = "Сохранить",
    savingLabel = ru.settings.saving,
    idleMessage = "Изменения не сохранены",
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
                    : "sticky bottom-[calc(var(--app-mini-player-inset)+var(--app-bottom-nav-height)+var(--safe-area-bottom)+0.75rem)] z-20 pt-4 md:bottom-3 md:pt-6"
            }
        >
            <div
                data-testid="settings-save-panel"
                className="grid grid-cols-1 gap-2 rounded-[14px] border border-line bg-surface-overlay/95 p-3 backdrop-blur-xl min-[420px]:grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] min-[420px]:items-center md:grid-cols-[minmax(0,1fr)_minmax(0,auto)]"
            >
                <div
                    data-testid="settings-save-status"
                    className="min-h-5 min-w-0 px-2"
                >
                    {status === "idle" ? (
                        <p
                            role="status"
                            className="break-words text-sm text-content-secondary"
                        >
                            {idleMessage}
                        </p>
                    ) : (
                        <InlineStatus
                            status={status}
                            message={message}
                            onClear={onStatusClear}
                            className="max-w-full break-words"
                        />
                    )}
                </div>
                <button
                    type="button"
                    onClick={onSave}
                    disabled={isSaving}
                    aria-busy={isSaving}
                    className="min-h-11 min-w-0 max-w-full w-full whitespace-normal break-words rounded-[10px] bg-brand px-[min(1.25rem,16px)] py-2.5 text-sm font-semibold leading-tight text-black transition-colors hover:bg-brand-hover active:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-2 focus-visible:ring-offset-surface-overlay disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-brand min-[420px]:w-auto motion-reduce:transition-none"
                >
                    {isSaving ? savingLabel : saveLabel}
                </button>
            </div>
        </div>
    );
}
