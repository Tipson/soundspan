"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type FormEvent,
} from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
    getAuthRuntimeGeneration,
    getAuthRuntimeLease,
} from "@/lib/auth-runtime-generation";
import {
    isRecommendationTraceId,
    type AdminRecommendationTraceResponse,
    type RecommendationGenerationTraceV1,
    type RecommendationTracePartName,
    type RecommendationTraceSource,
    type RecommendationTraceCounter,
} from "@/lib/api/recommendationTrace";
import { SettingsSection } from "../ui/SettingsSection";

const inputClass =
    "min-h-11 w-full min-w-0 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";
const buttonClass =
    "inline-flex min-h-11 items-center justify-center rounded-xl border border-line px-4 py-2 text-sm font-semibold text-content transition-colors hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const partLabels: Record<RecommendationTracePartName, string> = {
    providerPrior: "Приоритет источника",
    accountAffinity: "Близость аккаунту",
    moodFeatures: "Признаки настроения",
    positiveSimilarity: "Сходство со вкусом",
    negativeFeedback: "Негативные сигналы",
    moodSimilarity: "Вектор настроения",
    sessionPositive: "Сигналы сессии",
    contextSimilarity: "Контекст",
    recentRecording: "Недавняя запись",
    recentArtist: "Недавний исполнитель",
    recentAlbum: "Недавний альбом",
    exploration: "Исследование",
};
const sources: RecommendationTraceSource[] = [
    "youtube",
    "tidal",
    "library",
    "vk",
    "yandex",
];
const counterLabels: Record<RecommendationTraceCounter, string> = {
    input: "Вход кандидатов",
    invalidNative: "Неверные данные источника",
    disliked: "Негативные предпочтения",
    missingIdentity: "Нет identity",
    recentCooldown: "Недавняя выдача",
    duplicateCanonical: "Повтор canonical",
    artistCap: "Лимит исполнителя",
    albumCap: "Лимит альбома",
    laneCap: "Лимит полки",
    explorationReplaced: "Замены для исследования",
    freshSelected: "Выбрано в свежем проходе",
    backfillSelected: "Выбрано при дополнении",
};
const filterLabels: Record<
    keyof RecommendationGenerationTraceV1["filters"],
    string
> = {
    invalidNative: "Неверные данные источника",
    contentExcluded: "Не подходит для Wave",
    moodExcluded: "Не подходит настроению",
    disliked: "Отклонено по предпочтениям",
    feedbackUnavailable: "Проверка предпочтений недоступна",
};

function numeric(value: number | null | undefined): string {
    return typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "нет данных";
}

function TraceResult({
    data,
}: {
    data: Extract<AdminRecommendationTraceResponse, { available: true }>;
}) {
    const { trace } = data;
    return (
        <div className="space-y-5 pt-5 text-sm text-content-secondary">
            <p role="status" className="font-medium text-content">
                {data.served
                    ? "Выданная генерация"
                    : "Теневой расчёт — не выдано слушателю"}
            </p>
            <p className="break-words">
                {trace.policyVersion} · {trace.algorithm} · режим {trace.mode} ·{" "}
                {trace.assignment ?? "без switchback"}
            </p>
            <p>Выдача и теневой расчёт не подтверждают прослушивание.</p>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                {(
                    [
                        ["Загружено", trace.coverage.loadedCount],
                        ["Допущено", trace.coverage.admittedCount],
                        ["В ранжировании", trace.coverage.rankInputCount],
                        ["Возвращено", trace.returnedCount],
                        ["Запрошено", trace.requestedCount],
                        ["Недобор", trace.shortfallCount],
                        [
                            "Каноническая identity",
                            trace.coverage.canonicalIdPresentCount,
                        ],
                        ["Векторы", trace.coverage.embeddingPresentCount],
                    ] as const
                ).map(([label, value]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd className="mt-1 font-semibold tabular-nums text-content">
                            {numeric(value)}
                        </dd>
                    </div>
                ))}
            </dl>
            <div className="space-y-2">
                <h3 className="font-medium text-content">
                    Источники и проверки допуска
                </h3>
                <p className="flex flex-wrap gap-x-4 gap-y-1">
                    {sources.map((source) => (
                        <span key={source}>
                            {source}:{" "}
                            <span className="tabular-nums text-content">
                                {numeric(trace.coverage.loadedSources[source])}
                            </span>
                        </span>
                    ))}
                </p>
                <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {(
                        Object.keys(
                            filterLabels,
                        ) as (keyof typeof filterLabels)[]
                    ).map((key) => (
                        <div key={key} className="flex justify-between gap-3">
                            <dt>{filterLabels[key]}</dt>
                            <dd className="tabular-nums text-content">
                                {numeric(trace.filters[key])}
                            </dd>
                        </div>
                    ))}
                </dl>
            </div>
            {trace.ranker && (
                <details className="border-y border-line py-1">
                    <summary className="min-h-11 cursor-pointer py-3 text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                        Счётчики ранжирования
                    </summary>
                    <dl className="grid gap-x-6 gap-y-1 pb-3 sm:grid-cols-2">
                        {(
                            Object.keys(
                                counterLabels,
                            ) as RecommendationTraceCounter[]
                        ).map((key) => (
                            <div
                                key={key}
                                className="flex justify-between gap-3"
                            >
                                <dt>{counterLabels[key]}</dt>
                                <dd className="tabular-nums text-content">
                                    {numeric(trace.ranker!.counters[key])}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </details>
            )}
            <p>
                {trace.spacing.scope === "captured-prefix"
                    ? "Расстановка: сохранённый фрагмент"
                    : "Расстановка: вся страница"}{" "}
                · наблюдалось позиций: {numeric(trace.spacing.observedRows)} ·
                перемещено: {numeric(trace.spacing.movedOccurrences)}
            </p>
            {trace.truncated && (
                <p role="note">
                    Сохранённый фрагмент: показано{" "}
                    {Math.min(75, trace.items.length)} из {trace.returnedCount}{" "}
                    позиций. Подробности ограничены размером диагностики.
                </p>
            )}
            <div className="divide-y divide-line border-y border-line">
                {trace.items.slice(0, 75).map((item, index) => {
                    const exposure = data.exposures
                        .slice(0, 75)
                        .find(
                            (row) =>
                                row.position === item.position &&
                                row.source === item.source,
                        );
                    const scoring = item.scoring;
                    return (
                        <details
                            key={`${item.position}:${index}`}
                            data-trace-occurrence
                            className="py-1"
                        >
                            <summary className="min-h-11 cursor-pointer py-3 text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                                <span className="break-all">
                                    Позиция {item.position} · {item.source}
                                    {exposure?.providerTrackId
                                        ? ` · ${exposure.providerTrackId}`
                                        : ""}
                                </span>
                            </summary>
                            <div className="space-y-3 pb-4 pl-3">
                                <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                                    <div>
                                        <dt>Способ выбора</dt>
                                        <dd className="text-content">
                                            {scoring?.selection.method ??
                                                "нет данных"}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>Проход</dt>
                                        <dd className="text-content">
                                            {scoring?.selection.cooldown ??
                                                "не используется"}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>До расстановки (с нуля)</dt>
                                        <dd className="tabular-nums text-content">
                                            {numeric(item.rankPosition)}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>Базовый score</dt>
                                        <dd className="break-all tabular-nums text-content">
                                            {numeric(
                                                scoring?.baseScore ??
                                                    item.score,
                                            )}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>
                                            {scoring?.selection.method === "mmr"
                                                ? "MMR-оценка"
                                                : "Оценка выбора"}
                                        </dt>
                                        <dd className="break-all tabular-nums text-content">
                                            {numeric(scoring?.selection.score)}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>Штраф разнообразия</dt>
                                        <dd className="tabular-nums text-content">
                                            {numeric(
                                                scoring?.selection
                                                    .diversityPenalty,
                                            )}
                                        </dd>
                                    </div>
                                </dl>
                                {scoring ? (
                                    <dl className="space-y-1">
                                        {scoring.parts
                                            .slice(0, 12)
                                            .map((part) => (
                                                <div
                                                    key={part.name}
                                                    data-score-part={part.name}
                                                    className="flex flex-wrap justify-between gap-x-4"
                                                >
                                                    <dt>
                                                        {partLabels[part.name]}
                                                    </dt>
                                                    <dd className="break-all tabular-nums text-content">
                                                        {part.state === "unused"
                                                            ? "не используется"
                                                            : part.state ===
                                                                "absent"
                                                              ? "нет данных"
                                                              : numeric(
                                                                    part.value,
                                                                )}
                                                    </dd>
                                                </div>
                                            ))}
                                    </dl>
                                ) : (
                                    <p>Вклады в score не сохранены.</p>
                                )}
                            </div>
                        </details>
                    );
                })}
            </div>
            <p className="text-xs">
                Позиции указаны с нуля. Счётчики отражают проверки и события
                выбора; один кандидат может учитываться несколько раз.
            </p>
        </div>
    );
}

function TracePanel() {
    const [userId, setUserId] = useState("");
    const [generationId, setGenerationId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] =
        useState<AdminRecommendationTraceResponse | null>(null);
    const active = useRef<{ controller: AbortController } | null>(null);
    const invalidate = useCallback(() => {
        active.current?.controller.abort();
        active.current = null;
        setResult(null);
        setError("");
        setBusy(false);
    }, []);
    useEffect(
        () => () => {
            active.current?.controller.abort();
            active.current = null;
        },
        [],
    );

    async function read(event: FormEvent) {
        event.preventDefault();
        if (
            busy ||
            !isRecommendationTraceId(userId) ||
            !isRecommendationTraceId(generationId)
        )
            return;
        invalidate();
        const claim = { controller: new AbortController() };
        active.current = claim;
        const session = api.getSessionGeneration();
        const runtime = getAuthRuntimeGeneration();
        const current = () =>
            active.current === claim &&
            !claim.controller.signal.aborted &&
            session === api.getSessionGeneration() &&
            runtime === getAuthRuntimeGeneration();
        setBusy(true);
        try {
            const data = await api.getAdminRecommendationTrace(
                userId,
                generationId,
                claim.controller.signal,
            );
            if (!current()) return;
            if (data.generationId !== generationId)
                throw new Error("Trace response identity mismatch");
            setResult(data);
        } catch (failure: unknown) {
            if (!current()) return;
            setError(
                failure &&
                    typeof failure === "object" &&
                    "status" in failure &&
                    failure.status === 404
                    ? "Генерация не найдена для указанного пользователя. Проверьте идентификаторы."
                    : "Не удалось загрузить диагностику. Проверьте доступ и повторите запрос.",
            );
        } finally {
            if (active.current === claim) {
                active.current = null;
                setBusy(false);
            }
        }
    }
    return (
        <SettingsSection
            id="recommendation-trace"
            title="Диагностика рекомендаций"
            description="Прочитайте одну генерацию по точным идентификаторам аккаунта и выдачи. Запрос выполняется только по кнопке."
        >
            <form
                onSubmit={(event) => void read(event)}
                autoComplete="off"
                className="space-y-4"
            >
                <div className="grid gap-4 sm:grid-cols-2">
                    <label
                        htmlFor="recommendation-trace-user"
                        className="space-y-2 text-sm text-content"
                    >
                        <span className="block">ID пользователя</span>
                        <input
                            id="recommendation-trace-user"
                            name="trace-user"
                            value={userId}
                            onChange={(event) => {
                                invalidate();
                                setUserId(event.target.value);
                            }}
                            className={inputClass}
                            maxLength={128}
                            pattern={"^[A-Za-z0-9_\\-]{1,128}$"}
                            required
                            spellCheck={false}
                        />
                    </label>
                    <label
                        htmlFor="recommendation-trace-generation"
                        className="space-y-2 text-sm text-content"
                    >
                        <span className="block">ID генерации</span>
                        <input
                            id="recommendation-trace-generation"
                            name="trace-generation"
                            value={generationId}
                            onChange={(event) => {
                                invalidate();
                                setGenerationId(event.target.value);
                            }}
                            className={inputClass}
                            maxLength={128}
                            pattern={"^[A-Za-z0-9_\\-]{1,128}$"}
                            required
                            spellCheck={false}
                        />
                    </label>
                </div>
                <button
                    type="submit"
                    className={buttonClass}
                    disabled={
                        busy ||
                        !isRecommendationTraceId(userId) ||
                        !isRecommendationTraceId(generationId)
                    }
                >
                    {busy ? "Загрузка…" : "Прочитать диагностику"}
                </button>
            </form>
            {busy && (
                <p
                    role="status"
                    className="pt-3 text-sm text-content-secondary"
                >
                    Загружаем одну генерацию…
                </p>
            )}
            {error && (
                <p role="alert" className="pt-3 text-sm text-content-secondary">
                    {error}
                </p>
            )}
            {result?.available === false && (
                <p
                    role="status"
                    className="pt-3 text-sm text-content-secondary"
                >
                    Для этой генерации диагностика недоступна. Она могла быть
                    создана без сохранения диагностики.
                </p>
            )}
            {result?.available && <TraceResult data={result} />}
        </SettingsSection>
    );
}

/** Explicit private read, scoped to the current interactive administrator runtime. */
export function RecommendationTraceSection() {
    const { user, isAuthenticated, isLoading } = useAuth();
    const [, rerender] = useState(0);
    const runtime = getAuthRuntimeGeneration();
    useEffect(() => {
        const lease = getAuthRuntimeLease();
        const revoke = () => rerender((value) => value + 1);
        lease.signal.addEventListener("abort", revoke, { once: true });
        return () => lease.signal.removeEventListener("abort", revoke);
    }, [runtime]);
    if (isLoading || !isAuthenticated || !user?.id || user.role !== "admin")
        return null;
    return (
        <TracePanel
            key={`${user.id}:${api.getSessionGeneration()}:${runtime}`}
        />
    );
}
