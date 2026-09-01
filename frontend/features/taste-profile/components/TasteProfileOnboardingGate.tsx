"use client";

import { tasteProfileErrorMessage } from "../api";
import { useTasteProfile } from "../hooks/useTasteProfile";
import { TasteProfileDialog } from "./TasteProfileDialog";

export interface TasteProfileOnboardingGateProps {
    accountId: string;
    onFinished?: () => void;
}

const ignoreMandatoryClose = () => undefined;

/** Show first-run taste setup only when the current account explicitly needs it. */
export function TasteProfileOnboardingGate({
    accountId,
    onFinished,
}: TasteProfileOnboardingGateProps) {
    const tasteProfile = useTasteProfile(accountId);
    if (
        !accountId.trim() ||
        tasteProfile.isLoading ||
        tasteProfile.state?.needsOnboarding !== true
    ) {
        return null;
    }

    const initialSelection = tasteProfile.state.profile
        ? {
              genres: tasteProfile.state.profile.genres,
              artists: tasteProfile.state.profile.artists,
          }
        : { genres: [], artists: [] };
    const finish = async (action: Promise<unknown>) => {
        await action;
        onFinished?.();
    };

    return (
        <TasteProfileDialog
            key={accountId}
            mode="onboarding"
            initialSelection={initialSelection}
            isSaving={tasteProfile.isSaving}
            error={
                tasteProfile.error
                    ? tasteProfileErrorMessage(tasteProfile.error)
                    : null
            }
            onSave={(selection) => finish(tasteProfile.create(selection))}
            onSkip={() => finish(tasteProfile.skip("create"))}
            onClose={ignoreMandatoryClose}
        />
    );
}
