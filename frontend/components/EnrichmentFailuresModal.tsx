"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { enrichmentApi } from "@/lib/enrichmentApi";
import { createFrontendLogger } from "@/lib/logger";
import { RefreshCw, SkipForward, Trash2, AlertCircle } from "lucide-react";
import { Modal } from "./ui/Modal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { queryKeys } from "@/lib/queryKeys";

const FAILURE_ACTION =
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-3 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

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
        <ConfirmDialog
            isOpen
            onClose={onCancel}
            onConfirm={onConfirm}
            title="Повторить все ошибки в этой вкладке?"
            message={
                "Будет сброшено " +
                count +
                " неудачных " +
                (entityType === "audio"
                    ? "анализов аудио"
                    : "построений векторов Vibe") +
                ". Фоновая очередь обработает их постепенно."
            }
            confirmText="Повторить всё"
            variant="info"
        />
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
            <div className="shrink-0 flex flex-col items-start gap-3 border-b border-line py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p className="text-sm leading-5 text-content-secondary">
                        Повторить все ошибки из этой вкладки. Задачи будут
                        поступать в очередь анализа постепенно.
                    </p>
                    {isError && (
                        <p
                            role="alert"
                            className="mt-2 text-sm leading-5 text-error"
                        >
                            Не удалось запустить повтор. Проверьте журналы
                            сервера и попробуйте ещё раз.
                        </p>
                    )}
                </div>
                <button
                    onClick={() => setShowConfirm(true)}
                    disabled={isPending}
                    className={
                        FAILURE_ACTION +
                        " shrink-0 bg-brand text-black hover:bg-brand-hover"
                    }
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
        <>
            <Modal
                isOpen={isOpen}
                onClose={onClose}
                title="Ошибки анализа метаданных"
                className="flex max-w-4xl flex-col overflow-hidden"
                headerClassName="shrink-0"
                contentClassName="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                footerClassName="shrink-0 flex-wrap items-center justify-between border-t border-line pt-3"
                footer={
                    totalPages > 1 ? (
                        <>
                            <button
                                onClick={() =>
                                    setCurrentPage((p) => Math.max(1, p - 1))
                                }
                                disabled={currentPage === 1}
                                className={
                                    FAILURE_ACTION +
                                    " flex-1 bg-surface-hover text-content hover:bg-surface-active min-[420px]:flex-none"
                                }
                            >
                                Назад
                            </button>
                            <span className="order-first w-full text-center text-sm text-content-secondary min-[420px]:order-none min-[420px]:w-auto">
                                Страница {currentPage} из {totalPages}
                            </span>
                            <button
                                onClick={() =>
                                    setCurrentPage((p) =>
                                        Math.min(totalPages, p + 1),
                                    )
                                }
                                disabled={currentPage === totalPages}
                                className={
                                    FAILURE_ACTION +
                                    " flex-1 bg-surface-hover text-content hover:bg-surface-active min-[420px]:flex-none"
                                }
                            >
                                Вперёд
                            </button>
                        </>
                    ) : undefined
                }
            >
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
                    <p className="text-sm text-content-secondary">
                        {totalFailures}{" "}
                        {ruPlural(
                            totalFailures,
                            "ошибка требует",
                            "ошибки требуют",
                            "ошибок требуют",
                        )}{" "}
                        проверки
                    </p>
                    {totalFailures > 0 && (
                        <button
                            onClick={() => setShowClearConfirm(true)}
                            disabled={clearAllMutation.isPending}
                            className={
                                FAILURE_ACTION +
                                " bg-error/15 text-error hover:bg-error/25"
                            }
                        >
                            {clearAllMutation.isPending
                                ? "Удаляем…"
                                : "Удалить всё"}
                        </button>
                    )}
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
                <div
                    className="flex shrink-0 gap-2 overflow-x-auto border-b border-line py-3"
                    aria-label="Категории ошибок"
                >
                    {(
                        [
                            {
                                key: "all",
                                label: failureTypeLabels.all,
                                count: counts?.total || 0,
                            },
                            {
                                key: "artist",
                                label: failureTypeLabels.artist,
                                count: counts?.artist || 0,
                            },
                            {
                                key: "track",
                                label: failureTypeLabels.track,
                                count: counts?.track || 0,
                            },
                            {
                                key: "audio",
                                label: failureTypeLabels.audio,
                                count: counts?.audio || 0,
                            },
                            {
                                key: "vibe",
                                label: failureTypeLabels.vibe,
                                count: counts?.vibe || 0,
                            },
                        ] as const
                    ).map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => {
                                setSelectedType(tab.key);
                                setCurrentPage(1);
                                setSelectedFailures(new Set());
                            }}
                            aria-pressed={selectedType === tab.key}
                            className={
                                FAILURE_ACTION +
                                " shrink-0 whitespace-nowrap " +
                                (selectedType === tab.key
                                    ? "bg-brand text-black"
                                    : "bg-surface-hover text-content-secondary hover:bg-surface-active")
                            }
                        >
                            {tab.label} ({tab.count})
                        </button>
                    ))}
                </div>
                {selectedFailures.size > 0 && (
                    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line py-3">
                        <span className="text-sm text-content-secondary">
                            Выбрано: {selectedFailures.size}
                        </span>
                        <div className="flex flex-wrap gap-2 sm:ml-auto">
                            <button
                                onClick={handleRetrySelected}
                                disabled={retryMutation.isPending}
                                className={
                                    FAILURE_ACTION +
                                    " bg-brand text-black hover:bg-brand-hover"
                                }
                            >
                                <RefreshCw className="h-4 w-4" />
                                Повторить
                            </button>
                            <button
                                onClick={handleSkipSelected}
                                disabled={skipMutation.isPending}
                                className={
                                    FAILURE_ACTION +
                                    " bg-surface-hover text-content-secondary hover:bg-surface-active"
                                }
                            >
                                <SkipForward className="h-4 w-4" />
                                Пропустить
                            </button>
                        </div>
                    </div>
                )}
                <div className="py-3">
                    {isLoading ? (
                        <div className="flex h-48 items-center justify-center text-content-secondary">
                            Загружаем ошибки…
                        </div>
                    ) : failures?.failures.length === 0 ? (
                        <div className="flex h-48 flex-col items-center justify-center text-content-secondary">
                            <AlertCircle className="mb-3 h-10 w-10 opacity-50" />
                            <p className="text-lg font-medium">Ошибок нет</p>
                            <p className="mt-1 text-sm">
                                Все элементы успешно обработаны
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <label className="inline-flex min-h-11 items-center gap-3 px-3 text-sm text-content-secondary">
                                <input
                                    type="checkbox"
                                    aria-label="Выбрать все ошибки на этой странице"
                                    checked={
                                        selectedFailures.size ===
                                        failures?.failures.length
                                    }
                                    onChange={handleSelectAll}
                                    className="h-5 w-5 shrink-0 rounded border-line accent-brand"
                                />
                                Выбрать все
                            </label>
                            {failures?.failures.map((failure) => (
                                <div
                                    key={failure.id}
                                    className="flex items-start gap-2 rounded-[14px] border border-line bg-surface-hover p-3 sm:gap-3"
                                >
                                    <label className="inline-flex min-h-11 w-11 shrink-0 items-start justify-center pt-3">
                                        <input
                                            type="checkbox"
                                            aria-label={
                                                "Выбрать ошибку для " +
                                                (failure.entityName ||
                                                    failure.entityId)
                                            }
                                            checked={selectedFailures.has(
                                                failure.id,
                                            )}
                                            onChange={() =>
                                                toggleFailureSelection(
                                                    failure.id,
                                                )
                                            }
                                            className="h-5 w-5 shrink-0 rounded border-line accent-brand"
                                        />
                                    </label>
                                    <div className="min-w-0 flex-1 py-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="break-words text-sm font-medium text-content">
                                                {failure.entityName ||
                                                    failure.entityId}
                                            </span>
                                            <span className="rounded bg-surface-active px-2 py-0.5 text-xs text-content-secondary">
                                                {failureTypeLabels[
                                                    failure.entityType as FailureType
                                                ] ?? failure.entityType}
                                            </span>
                                        </div>
                                        <p className="mt-2 break-words text-xs leading-5 text-error">
                                            {failure.errorSummary ||
                                                failure.errorCode ||
                                                "Подробности ошибки не сохранены"}
                                        </p>
                                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-content-muted">
                                            <span>
                                                Попытка {failure.retryCount}/
                                                {failure.maxRetries}
                                            </span>
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
                                        aria-label={
                                            "Удалить запись об ошибке для " +
                                            (failure.entityName ||
                                                failure.entityId)
                                        }
                                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-error transition-colors hover:bg-error/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </Modal>
            <ConfirmDialog
                isOpen={showClearConfirm}
                onClose={() => setShowClearConfirm(false)}
                onConfirm={() =>
                    clearAllMutation.mutate(
                        selectedType === "all" ? undefined : selectedType,
                    )
                }
                title="Удалить все ошибки?"
                message={
                    "Будут безвозвратно удалены ошибки категории «" +
                    failureTypeLabels[selectedType] +
                    "»: " +
                    (selectedType === "all"
                        ? totalFailures
                        : counts?.[selectedType] || 0) +
                    ". Это действие нельзя отменить."
                }
                confirmText="Удалить всё"
                variant="danger"
            />
        </>
    );
}
