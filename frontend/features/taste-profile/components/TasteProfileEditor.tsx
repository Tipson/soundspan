"use client";

import { tasteProfileErrorMessage } from "../api";
import { useTasteProfile } from "../hooks/useTasteProfile";
import { TasteProfileDialog } from "./TasteProfileDialog";

export interface TasteProfileEditorProps {
    accountId: string;
    isOpen: boolean;
    onClose: () => void;
    onSaved?: () => void;
}

/** Controlled editor ready to mount from account settings in a later integration pass. */
export function TasteProfileEditor({
    accountId,
    isOpen,
    onClose,
    onSaved,
}: TasteProfileEditorProps) {
    const tasteProfile = useTasteProfile(accountId, isOpen);
    if (!isOpen || !accountId.trim() || !tasteProfile.state) return null;
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
