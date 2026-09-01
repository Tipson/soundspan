"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { enrichmentApi } from "@/lib/enrichmentApi";
import { createFrontendLogger } from "@/lib/logger";
import { X, RefreshCw, SkipForward, Trash2, AlertCircle } from "lucide-react";
import { queryKeys } from "@/lib/queryKeys";

const logger = createFrontendLogger("EnrichmentFailuresModal");

interface EnrichmentFailuresModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type RetryableFailureType = "audio" | "vibe";

type FailureType = "all" | "artist" | "track" | RetryableFailureType;

const failureTypeLabels: Record<FailureType, string> = {
    all: "Все",
    artist: "Исполнители",
    track: "Треки",
    audio: "Анализ аудио",
    vibe: "Векторы Vibe",
};

function ruPlural(
    count: number,
    one: string,
    few: string,
    many: string,
): string {
    const normalized = Math.abs(count) % 100;
    const lastDigit = normalized % 10;
    if (normalized >= 11 && normalized <= 19) return many;
    if (lastDigit === 1) return one;
    if (lastDigit >= 2 && lastDigit <= 4) return few;
    return many;
}

interface RetryAllConfirmationDialogProps {
    count: number;
    entityType: RetryableFailureType;
    onCancel: () => void;
    onConfirm: () => void;
}

function RetryAllConfirmationDialog({
    count,
    entityType,
    onCancel,
    onConfirm,
}: RetryAllConfirmationDialogProps) {
    return (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4">
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="retry-all-title"
                className="bg-surface-hover rounded-lg p-6 max-w-md border border-white/10"
            >
                <h3
                    id="retry-all-title"
                    className="text-lg font-bold text-white mb-2"
                >
                    Повторить все ошибки в этой вкладке?
                </h3>
                <p className="text-sm text-white/70 mb-4">
                    Будет сброшено {count} неудачных{" "}
                    {entityType === "audio"
                        ? "анализов аудио"
                        : "построений векторов Vibe"}
                    . Фоновая очередь обработает их постепенно.
                </p>
                <div className="flex justify-end gap-2">
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 text-sm bg-white/10 text-white/70 rounded-lg hover:bg-white/20 transition-colors"
                    >
                        Отмена
                    </button>
                    <button
                        onClick={onConfirm}
                        className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                    >
                        Повторить всё
                    </button>
                </div>
            </div>
        </div>
    );
}

interface RetryAllFailuresActionProps {
    count: number;
    entityType: RetryableFailureType;
    isError: boolean;
    isPending: boolean;
    onRetry: () => void;
}

function RetryAllFailuresAction({
    count,
    entityType,
    isError,
    isPending,
    onRetry,
}: RetryAllFailuresActionProps) {
    const [showConfirm, setShowConfirm] = useState(false);
    if (count <= 0) return null;

    return (
        <>
            <div className="shrink-0 flex items-center justify-between gap-3 px-6 py-3 bg-white/5 border-b border-white/10">
                <div>
                    <p className="text-sm text-white/60">
                        Повторить все ошибки из этой вкладки. Задачи будут
                        поступать в очередь анализа постепенно.
                    </p>
                    {isError && (
                        <p role="alert" className="text-xs text-red-400 mt-1">
                            Не удалось запустить повтор. Проверьте журналы
                            сервера и попробуйте ещё раз.
                        </p>
                    )}
                </div>
                <button
                    onClick={() => setShowConfirm(true)}
                    disabled={isPending}
                    className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg
                        hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {isPending ? "Запускаем…" : `Повторить все (${count})`}
                </button>
            </div>
            {showConfirm && (
                <RetryAllConfirmationDialog
                    count={count}
                    entityType={entityType}
                    onCancel={() => setShowConfirm(false)}
                    onConfirm={() => {
                        onRetry();
                        setShowConfirm(false);
                    }}
                />
            )}
        </>
    );
}

/**
 * Renders the EnrichmentFailuresModal component.
 */
export function EnrichmentFailuresModal({
    isOpen,
    onClose,
}: EnrichmentFailuresModalProps) {
    const [selectedType, setSelectedType] = useState<FailureType>("all");
    const [selectedFailures, setSelectedFailures] = useState<Set<string>>(
        new Set(),
    );
    const [currentPage, setCurrentPage] = useState(1);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const pageSize = 20;
    const queryClient = useQueryClient();
    const wasOpenRef = useRef(false);

    const invalidateFailureQueries = () => {
        queryClient.invalidateQueries({
            queryKey: queryKeys.enrichmentFailuresAll(),
        });
        queryClient.invalidateQueries({
            queryKey: queryKeys.enrichmentFailureCounts(),
        });
    };

    const { mutate: reconcileFailures } = useMutation({
        mutationFn: () => enrichmentApi.reconcileFailures(),
        onSettled: invalidateFailureQueries,
    });

    useEffect(() => {
        if (isOpen && !wasOpenRef.current) {
            reconcileFailures();
        }
        wasOpenRef.current = isOpen;
    }, [isOpen, reconcileFailures]);

    // Fetch failures
    const { data: failures, isLoading } = useQuery({
        queryKey: queryKeys.enrichmentFailures(selectedType, currentPage),
        queryFn: async () => {
            const params: Record<string, string | number | boolean> = {
                limit: pageSize,
                offset: (currentPage - 1) * pageSize,
                resolved: false,
            };
            if (selectedType !== "all") {
                params.entityType = selectedType;
            }
            return enrichmentApi.getFailures(params);
        },
        enabled: isOpen,
    });

    // Fetch counts
    const { data: counts } = useQuery({
        queryKey: queryKeys.enrichmentFailureCounts(),
        queryFn: () => enrichmentApi.getFailureCounts(),
        enabled: isOpen,
    });

    // Retry mutation
    const retryMutation = useMutation({
        mutationFn: (failureIds: string[]) =>
            enrichmentApi.retryFailures(failureIds),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentFailuresAll(),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentFailureCounts(),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentProgress(),
            });
            setSelectedFailures(new Set());
        },
    });

    // Skip mutation
    const skipMutation = useMutation({
        mutationFn: (failureIds: string[]) =>
            enrichmentApi.skipFailures(failureIds),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentFailuresAll(),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentFailureCounts(),
            });
            setSelectedFailures(new Set());
        },
    });

    // Delete mutation
    const deleteMutation = useMutation({
        mutationFn: (failureId: string) =>
            enrichmentApi.deleteFailure(failureId),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentFailuresAll(),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentFailureCounts(),
            });
        },
    });

    // Clear all mutation
    const clearAllMutation = useMutation({
        mutationFn: (entityType?: "artist" | "track" | "audio" | "vibe") =>
            enrichmentApi.clearAllFailures(entityType),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentFailuresAll(),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentFailureCounts(),
            });
            setSelectedFailures(new Set());
        },
    });

    const retryAllMutation = useMutation({
        mutationFn: (entityType: "audio" | "vibe") =>
            entityType === "audio"
                ? enrichmentApi.retryFailedAudioAnalysis()
                : enrichmentApi.retryVibeEmbeddings(),
        onSuccess: async () => {
            invalidateFailureQueries();
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentProgress(),
            });
            setSelectedFailures(new Set());
            try {
                await enrichmentApi.reconcileFailures();
            } catch (error) {
                logger.error("Failed to reconcile retried failures", error);
            } finally {
                invalidateFailureQueries();
            }
        },
    });

    const toggleFailureSelection = (id: string) => {
        const newSelected = new Set(selectedFailures);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedFailures(newSelected);
    };

    const handleSelectAll = () => {
        if (selectedFailures.size === failures?.failures.length) {
            setSelectedFailures(new Set());
        } else {
            setSelectedFailures(
                new Set(failures?.failures.map((f) => f.id) || []),
            );
        }
    };

    const handleRetrySelected = () => {
        if (selectedFailures.size > 0) {
            retryMutation.mutate(Array.from(selectedFailures));
        }
    };

    const handleSkipSelected = () => {
        if (selectedFailures.size > 0) {
            skipMutation.mutate(Array.from(selectedFailures));
        }
    };

    if (!isOpen) return null;

    const totalFailures = counts?.total || 0;
    const totalPages = Math.ceil((failures?.total || 0) / pageSize);

    return (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
            <div className="bg-surface-hover rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col border border-white/10">
                {/* Header */}
                <div className="shrink-0 flex items-center justify-between p-6 border-b border-white/10">
                    <div>
                        <h2 className="text-xl font-bold text-white">
                            Ошибки анализа метаданных
                        </h2>
                        <p className="text-sm text-white/50 mt-1">
                            {totalFailures}{" "}
                            {ruPlural(
                                totalFailures,
                                "ошибка требует",
                                "ошибки требуют",
                                "ошибок требуют",
                            )}{" "}
                            проверки
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {totalFailures > 0 && (
                            <button
                                onClick={() => setShowClearConfirm(true)}
                                disabled={clearAllMutation.isPending}
                                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg
                                    hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {clearAllMutation.isPending
                                    ? "Удаляем…"
                                    : "Удалить всё"}
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            aria-label="Закрыть список ошибок анализа"
                            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <X className="w-5 h-5 text-white/70" />
                        </button>
                    </div>
                </div>

                {(selectedType === "audio" || selectedType === "vibe") && (
                    <RetryAllFailuresAction
                        count={counts?.[selectedType] || 0}
                        entityType={selectedType}
                        isError={retryAllMutation.isError}
                        isPending={retryAllMutation.isPending}
                        onRetry={() => retryAllMutation.mutate(selectedType)}
                    />
                )}

                {/* Filter Tabs */}
                <div className="shrink-0 flex gap-3 px-6 py-4 border-b border-white/10 overflow-x-auto">
                    {[
                        {
                            key: "all" as const,
                            label: failureTypeLabels.all,
                            count: counts?.total || 0,
                        },
                        {
                            key: "artist" as const,
                            label: failureTypeLabels.artist,
                            count: counts?.artist || 0,
                        },
                        {
                            key: "track" as const,
                            label: failureTypeLabels.track,
                            count: counts?.track || 0,
                        },
                        {
                            key: "audio" as const,
                            label: failureTypeLabels.audio,
                            count: counts?.audio || 0,
                        },
                        {
                            key: "vibe" as const,
                            label: failureTypeLabels.vibe,
                            count: counts?.vibe || 0,
                        },
                    ].map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => {
                                setSelectedType(tab.key);
                                setCurrentPage(1);
                                setSelectedFailures(new Set());
                            }}
                            className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                                selectedType === tab.key
                                    ? "bg-brand text-black"
                                    : "bg-white/5 text-white/70 hover:bg-white/10"
                            }`}
                            aria-pressed={selectedType === tab.key}
                        >
                            {tab.label} ({tab.count})
                        </button>
                    ))}
                </div>

                {/* Action Bar */}
                {selectedFailures.size > 0 && (
                    <div className="shrink-0 flex items-center gap-2 p-4 bg-white/5 border-b border-white/10">
                        <span className="text-sm text-white/70">
                            Выбрано: {selectedFailures.size}
                        </span>
                        <div className="flex gap-2 ml-auto">
                            <button
                                onClick={handleRetrySelected}
                                disabled={retryMutation.isPending}
                                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg
                                    hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <RefreshCw className="w-3.5 h-3.5" />
                                Повторить
                            </button>
                            <button
                                onClick={handleSkipSelected}
                                disabled={skipMutation.isPending}
                                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white/10 text-white/70 rounded-lg
                                    hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <SkipForward className="w-3.5 h-3.5" />
                                Пропустить
                            </button>
                        </div>
                    </div>
                )}

                {/* Failures List */}
                <div className="flex-1 overflow-y-auto p-4">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-64">
                            <div className="text-white/50">
                                Загружаем ошибки…
                            </div>
                        </div>
                    ) : failures?.failures.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-white/50">
                            <AlertCircle className="w-12 h-12 mb-3 opacity-50" />
                            <p className="text-lg font-medium">Ошибок нет</p>
                            <p className="text-sm mt-1">
                                Все элементы успешно обработаны
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {/* Select All */}
                            <div className="flex items-center gap-3 px-3 py-2">
                                <input
                                    type="checkbox"
                                    aria-label="Выбрать все ошибки на этой странице"
                                    checked={
                                        selectedFailures.size ===
                                        failures?.failures.length
                                    }
                                    onChange={handleSelectAll}
                                    className="w-4 h-4 rounded border-white/20 bg-white/10"
                                />
                                <span className="text-sm text-white/50">
                                    Выбрать все
                                </span>
                            </div>

                            {failures?.failures.map((failure) => (
                                <div
                                    key={failure.id}
                                    className="flex items-start gap-3 p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                                >
                                    <input
                                        type="checkbox"
                                        aria-label={`Выбрать ошибку для ${failure.entityName || failure.entityId}`}
                                        checked={selectedFailures.has(
                                            failure.id,
                                        )}
                                        onChange={() =>
                                            toggleFailureSelection(failure.id)
                                        }
                                        className="w-4 h-4 mt-1 rounded border-white/20 bg-white/10"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-white truncate">
                                                {failure.entityName ||
                                                    failure.entityId}
                                            </span>
                                            <span className="text-xs px-2 py-0.5 bg-white/10 text-white/50 rounded uppercase">
                                                {failureTypeLabels[
                                                    failure.entityType as FailureType
                                                ] ?? failure.entityType}
                                            </span>
                                        </div>
                                        <p className="text-xs text-red-400 mt-1">
                                            {failure.errorSummary ||
                                                failure.errorCode ||
                                                "Подробности ошибки не сохранены"}
                                        </p>
                                        <div className="flex items-center gap-3 mt-2 text-[10px] text-white/30">
                                            <span>
                                                Попытка {failure.retryCount}/
                                                {failure.maxRetries}
                                            </span>
                                            <span>•</span>
                                            <span>
                                                Последняя:{" "}
                                                {new Date(
                                                    failure.lastFailedAt,
                                                ).toLocaleString("ru-RU")}
                                            </span>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() =>
                                            deleteMutation.mutate(failure.id)
                                        }
                                        disabled={deleteMutation.isPending}
                                        className="p-2 hover:bg-red-500/20 rounded-lg transition-colors"
                                        title="Удалить запись об ошибке"
                                    >
                                        <Trash2 className="w-4 h-4 text-red-400" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="shrink-0 flex items-center justify-between p-4 border-t border-white/10">
                        <button
                            onClick={() =>
                                setCurrentPage((p) => Math.max(1, p - 1))
                            }
                            disabled={currentPage === 1}
                            className="px-3 py-1.5 text-sm bg-white/10 text-white/70 rounded-lg
                                hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            Назад
                        </button>
                        <span className="text-sm text-white/50">
                            Страница {currentPage} из {totalPages}
                        </span>
                        <button
                            onClick={() =>
                                setCurrentPage((p) =>
                                    Math.min(totalPages, p + 1),
                                )
                            }
                            disabled={currentPage === totalPages}
                            className="px-3 py-1.5 text-sm bg-white/10 text-white/70 rounded-lg
                                hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            Вперёд
                        </button>
                    </div>
                )}
            </div>

            {/* Clear All Confirmation Dialog */}
            {showClearConfirm && (
                <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4">
                    <div className="bg-surface-hover rounded-lg p-6 max-w-md border border-white/10">
                        <h3 className="text-lg font-bold text-white mb-2">
                            Удалить все ошибки?
                        </h3>
                        <p className="text-sm text-white/70 mb-4">
                            Будут безвозвратно удалены ошибки категории «
                            {failureTypeLabels[selectedType]}»:{" "}
                            {selectedType === "all"
                                ? totalFailures
                                : counts?.[selectedType] || 0}
                            . Это действие нельзя отменить.
                        </p>
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => setShowClearConfirm(false)}
                                className="px-4 py-2 text-sm bg-white/10 text-white/70 rounded-lg
                                    hover:bg-white/20 transition-colors"
                            >
                                Отмена
                            </button>
                            <button
                                onClick={() => {
                                    clearAllMutation.mutate(
                                        selectedType === "all"
                                            ? undefined
                                            : selectedType,
                                    );
                                    setShowClearConfirm(false);
                                }}
                                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg
                                    hover:bg-red-700 transition-colors"
                            >
                                Удалить всё
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
