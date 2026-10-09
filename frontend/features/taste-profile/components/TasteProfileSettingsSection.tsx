"use client";

import { useState } from "react";
import {
    SettingsRow,
    SettingsSection,
} from "@/features/settings/components/ui";
import { pluralRu } from "@/lib/i18n/ru";
import { useTasteProfile } from "../hooks/useTasteProfile";
import { TasteProfileEditor } from "./TasteProfileEditor";

export interface TasteProfileSettingsSectionProps {
    accountId: string;
}

/** Lets the current account review and replace the onboarding taste signals. */
export function TasteProfileSettingsSection({
    accountId,
}: TasteProfileSettingsSectionProps) {
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const tasteProfile = useTasteProfile(accountId);
    const profile = tasteProfile.state?.profile;
    const resolution = profile?.resolution;
    const signalCount =
        (profile?.genres.length ?? 0) + (profile?.artists.length ?? 0);
    const summary = tasteProfile.isLoading
        ? "Загружаем профиль…"
        : signalCount > 0
          ? `${signalCount} ${pluralRu(signalCount, ["выбор", "выбора", "выборов"])} сохранено для этого аккаунта`
          : "Вы пока не выбрали жанры и артистов";

    return (
        <>
            <SettingsSection
                id="taste-profile"
                title="Музыкальные вкусы"
                description="Если ваши музыкальные предпочтения изменились, расскажите, каких исполнителей вы хотите слышать чаще."
            >
                <SettingsRow label="Любимые исполнители" description={summary}>
                    <button
                        type="button"
                        disabled={tasteProfile.isLoading || !accountId.trim()}
                        onClick={() => setIsEditorOpen(true)}
                        className="min-h-11 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-content transition-colors hover:border-white/20 hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Уточнить предпочтения
                    </button>
                </SettingsRow>
                {resolution && (
                    <p
                        role="status"
                        className="mt-3 text-sm leading-6 text-content-secondary"
                    >
                        {resolution.attempts < 3
                            ? "Предпочтения сохранены. Часть музыки пока недоступна — повторим подбор автоматически, когда приложение будет открыто."
                            : "Предпочтения сохранены, но часть музыки подобрать не удалось. Откройте «Уточнить предпочтения» и сохраните выбор ещё раз, чтобы повторить подбор."}
                    </p>
                )}
            </SettingsSection>

            <TasteProfileEditor
                accountId={accountId}
                isOpen={isEditorOpen}
                onClose={() => setIsEditorOpen(false)}
            />
        </>
    );
}
