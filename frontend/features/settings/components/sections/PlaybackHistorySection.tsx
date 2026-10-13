"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { SettingsSection, SettingsRow, SettingsSelect } from "../ui";
import {
    getImpactedHistoryCount,
    HISTORY_RANGE_OPTIONS,
    MY_HISTORY_ROUTE,
    type HistoryRange,
    type PlayHistorySummary,
} from "./playbackHistoryConfig";
import { userFacingError } from "@/lib/i18n/ru";
import {
    SETTINGS_DANGER_BUTTON,
    SETTINGS_SECONDARY_BUTTON,
} from "../ui/settingsFieldStyles";

/**
 * Renders the PlaybackHistorySection component.
 */
export function PlaybackHistorySection() {
    const [selectedRange, setSelectedRange] = useState<HistoryRange>("30d");
    const [confirmClear, setConfirmClear] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [status, setStatus] = useState<StatusType>("idle");
    const [statusMessage, setStatusMessage] = useState("");
    const [summaryLoading, setSummaryLoading] = useState(true);
    const [summary, setSummary] = useState<PlayHistorySummary | null>(null);

    const loadSummary = async () => {
        setSummaryLoading(true);
        try {
            const response = await api.getPlayHistorySummary();
            setSummary(response);
        } catch {
            // Keep UI usable even if summary fetch fails
        } finally {
            setSummaryLoading(false);
        }
    };

    useEffect(() => {
        loadSummary();
    }, []);

    useEffect(() => {
        setConfirmClear(false);
        setStatus("idle");
        setStatusMessage("");
    }, [selectedRange]);

    const impactedCount = useMemo(() => {
        return getImpactedHistoryCount(summary, selectedRange);
    }, [selectedRange, summary]);

    const handleClearHistory = async () => {
        if (!confirmClear || clearing) return;

        setClearing(true);
        setStatus("loading");
        setStatusMessage("Очищаем историю прослушиваний…");

        try {
            const result = await api.clearPlayHistory(selectedRange);
            setStatus("success");
            setStatusMessage(
                `Удалено событий: ${result.deletedCount.toLocaleString("ru-RU")}`,
            );
            setConfirmClear(false);
            await loadSummary();
        } catch (error: unknown) {
            setStatus("error");
            setStatusMessage(
                userFacingError(
                    error,
                    "Не удалось очистить историю прослушиваний",
                ),
            );
        } finally {
            setClearing(false);
        }
    };

    return (
        <SettingsSection
            id="history"
            title="История и персонализация"
            description="История прослушиваний используется для рекомендаций и миксов."
        >
            <div className="mb-3 rounded-[10px] border border-warning/25 bg-warning/10 p-4">
                <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
                    <div className="text-sm text-content-secondary space-y-2">
                        <p>
                            После очистки рекомендации временно станут менее
                            точными, пока не накопится новая история.
                        </p>
                        <p>
                            Это повлияет на рекомендуемых исполнителей, новые
                            находки, лучшие треки и автоматические миксы.
                        </p>
                    </div>
                </div>
            </div>

            <SettingsRow
                label="История прослушиваний"
                description="Откройте полную историю с действиями воспроизведения, очереди и плейлистов."
            >
                <Link
                    href={MY_HISTORY_ROUTE}
                    className={SETTINGS_SECONDARY_BUTTON}
                >
                    Открыть мою историю
                </Link>
            </SettingsRow>

            <SettingsRow
                label="Очистить историю прослушиваний"
                description="Удаляются только события прослушивания этого аккаунта. Треки, плейлисты и файлы останутся на месте."
                align="start"
            >
                <div className="flex flex-col items-start gap-3 sm:items-end">
                    <SettingsSelect
                        value={selectedRange}
                        onChange={(value) =>
                            setSelectedRange(value as HistoryRange)
                        }
                        options={HISTORY_RANGE_OPTIONS}
                        disabled={clearing}
                    />
                    <button
                        onClick={handleClearHistory}
                        disabled={!confirmClear || clearing}
                        className={SETTINGS_DANGER_BUTTON}
                    >
                        {clearing ? "Очищаем…" : "Очистить историю"}
                    </button>
                </div>
            </SettingsRow>

            <div className="pt-1 space-y-2">
                <label className="flex min-h-11 items-start gap-3 py-2 text-sm leading-5 text-content-secondary cursor-pointer">
                    <input
                        type="checkbox"
                        checked={confirmClear}
                        onChange={(e) => setConfirmClear(e.target.checked)}
                        disabled={clearing}
                        className="mt-0.5 h-5 w-5 shrink-0 rounded border-line bg-surface-highlight text-red-500 focus:ring-red-500/40"
                    />
                    <span>
                        Я понимаю, что это повлияет на персональные
                        рекомендации.
                        {selectedRange === "all" && (
                            <span className="text-red-300">
                                {" "}
                                Будет удалена вся история за всё время.
                            </span>
                        )}
                    </span>
                </label>

                <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xs text-gray-400">
                        {summaryLoading
                            ? "Считаем события…"
                            : `Будет удалено примерно: ${(impactedCount ?? 0).toLocaleString("ru-RU")}`}
                    </p>
                    <InlineStatus
                        status={status}
                        message={statusMessage}
                        onClear={() => setStatus("idle")}
                    />
                </div>
            </div>
        </SettingsSection>
    );
}
