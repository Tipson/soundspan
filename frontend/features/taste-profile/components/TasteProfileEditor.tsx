"use client";

import { tasteProfileErrorMessage } from "../api";
import { Modal } from "@/components/ui/Modal";
import { useTasteProfile } from "../hooks/useTasteProfile";
import { TasteProfileDialog } from "./TasteProfileDialog";

export interface TasteProfileEditorProps {
    accountId: string;
    isOpen: boolean;
    onClose: () => void;
    onSaved?: () => void;
}

/** Account settings editor with recoverable loading and persistence failures. */
export function TasteProfileEditor({
    accountId,
    isOpen,
    onClose,
    onSaved,
}: TasteProfileEditorProps) {
    const tasteProfile = useTasteProfile(accountId, isOpen);
    if (!isOpen || !accountId.trim()) return null;
    if (!tasteProfile.state) {
        return (
            <Modal isOpen onClose={onClose} title="Музыкальные вкусы">
                {tasteProfile.isLoading ? (
                    <p role="status" className="text-sm text-content-secondary">
                        Загружаем музыкальные вкусы…
                    </p>
                ) : (
                    <div className="space-y-4">
                        <p
                            role="alert"
                            className="text-sm text-content-secondary"
                        >
                            Не удалось загрузить музыкальные вкусы. Проверьте
                            подключение и попробуйте ещё раз.
                        </p>
                        <button
                            type="button"
                            onClick={() => void tasteProfile.refetch()}
                            className="min-h-11 rounded-full bg-brand px-4 py-2 text-sm font-bold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        >
                            Повторить загрузку
                        </button>
                    </div>
                )}
            </Modal>
        );
    }
    const profile = tasteProfile.state.profile;

    return (
        <TasteProfileDialog
            key={`${accountId}:${tasteProfile.state.completedAt ?? "empty"}`}
            mode="edit"
            initialSelection={{
                genres: profile?.genres ?? [],
                artists: profile?.artists ?? [],
            }}
            isSaving={tasteProfile.isSaving}
            error={
                tasteProfile.error
                    ? tasteProfileErrorMessage(tasteProfile.error)
                    : null
            }
            onSave={async (selection) => {
                await tasteProfile.replace(selection);
                onSaved?.();
                onClose();
            }}
            onClose={onClose}
        />
    );
}
