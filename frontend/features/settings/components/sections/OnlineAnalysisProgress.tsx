"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { OnlineAnalysisStage } from "@/lib/api/onlineAnalysis";
import { queryKeys } from "@/lib/queryKeys";

function Coverage({
    label,
    total,
    stage,
}: {
    label: string;
    total: number;
    stage: OnlineAnalysisStage;
}) {
    const percentage = Math.floor((stage.completed / total) * 100);
    return (
        <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap justify-between gap-2 text-sm">
                <h4 className="font-medium text-white">{label}</h4>
                <span className="text-white/70 tabular-nums">{`${stage.completed} из ${total} · ${percentage}%`}</span>
            </div>
            <div
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={stage.completed}
                className="h-1.5 bg-white/10 rounded-full overflow-hidden"
            >
                <div
                    className="h-full bg-brand transition-all"
                    style={{ width: `${percentage}%` }}
                />
            </div>
            <p className="text-xs text-white/50 leading-relaxed">
                {`Без готового результата: ${stage.remaining} · из них с ошибкой: ${stage.failed} · за 24 часа: +${stage.completedLast24h}`}
            </p>
        </div>
    );
}

/** Show actual shared online analysis coverage separately from local file jobs. */
export function OnlineAnalysisProgress() {
    const { data, isPending, isError, refetch } = useQuery({
        queryKey: queryKeys.onlineAnalysisProgress(),
        queryFn: ({ signal }) => api.getOnlineAnalysisProgress(signal),
        staleTime: 30_000,
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
        retry: false,
        retryOnMount: false,
    });
    return (
        <section
            aria-label="Онлайн-аудиоанализ"
            className="mb-6 p-4 space-y-4 bg-white/5 rounded-lg border border-white/10"
        >
            <div>
                <h3 className="text-sm font-medium text-white">
                    Онлайн-аудиоанализ
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-white/50">
                    Общий каталог рекомендаций: одна запись считается один раз
                    для всех аккаунтов и источников. Локальные файлы показаны
                    отдельно ниже.
                </p>
            </div>
            {isPending && (
                <p className="text-sm text-white/50">Загружаем счётчики…</p>
            )}
            {isError && (
                <div
                    role="alert"
                    className="flex flex-wrap items-center gap-3 text-sm text-error"
                >
                    <span>
                        {data
                            ? "Не удалось обновить. Показаны последние полученные данные."
                            : "Не удалось загрузить счётчики анализа."}
                    </span>
                    <button
                        type="button"
                        onClick={() => void refetch()}
                        className="px-3 py-2 rounded-full border border-white/20 text-white/80"
                    >
                        Повторить
                    </button>
                </div>
            )}
            {data && (
                <>
                    {!data.enabled && (
                        <p className="text-sm text-warning">
                            Постановка онлайн-аудио в анализ отключена. Готовые
                            результаты сохранены.
                        </p>
                    )}
                    {data.total === 0 ? (
                        <p className="text-sm text-white/50">
                            В общем каталоге пока нет записей.
                        </p>
                    ) : (
                        <>
                            <Coverage
                                label="Аудиоанализ · Essentia"
                                total={data.total}
                                stage={data.audio}
                            />
                            {data.embeddings ? (
                                <Coverage
                                    label="Vibe-эмбеддинги · активная модель"
                                    total={data.total}
                                    stage={data.embeddings}
                                />
                            ) : (
                                <p className="text-sm text-white/50">
                                    Нет активной модели эмбеддингов. Покрытие
                                    недоступно.
                                </p>
                            )}
                        </>
                    )}
                    <div className="pt-3 border-t border-white/10 text-xs leading-relaxed text-white/50 space-y-1">
                        <p>{`Активных заданий с аудио: ${data.activeAssets} · суточная квота: ${data.budget.dailyLimit} записей · параллельность онлайн-обработчика: ${data.budget.concurrency}`}</p>
                        {data.budget.checkedToday === null ? (
                            <p>Использование квоты временно недоступно.</p>
                        ) : (
                            data.budget.checkedToday >=
                                data.budget.dailyLimit && (
                                <p className="text-warning">
                                    Квота на сегодня исчерпана. Обновится в{" "}
                                    {new Date(
                                        data.budget.resetsAt,
                                    ).toLocaleTimeString("ru-RU", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                    })}{" "}
                                    по времени устройства; уже принятые задания
                                    могут завершаться.
                                </p>
                            )
                        )}
                        <p>
                            Без готового результата — не очередь: приоритет
                            получают лайки, плейлисты, прослушивания и семена
                            Волны.
                        </p>
                        <p>
                            Снимок:{" "}
                            {new Date(data.generatedAt).toLocaleString("ru-RU")}
                            . Обновление каждые 30 секунд.
                        </p>
                    </div>
                </>
            )}
        </section>
    );
}
