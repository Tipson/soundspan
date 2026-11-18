"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
    api,
    type ImportDraftCategory,
    type ImportDraftConfirmation,
    type ImportDraftJob,
    type ImportDraftUpload,
} from "@/lib/api";
import {
    getAuthRuntimeGeneration,
    getAuthRuntimeLease,
} from "@/lib/auth-runtime-generation";
import { queryKeys } from "@/lib/queryKeys";
import { invalidatePersonalSearch } from "@/features/search/invalidatePersonalSearch";
import { useVisibilityGatedInterval } from "@/hooks/useVisibilityGatedInterval";

const MAX_FILE_BYTES = 512 * 1024;
const CATEGORIES: ImportDraftCategory[] = [
    "playlists",
    "likes",
    "albums",
    "artists",
    "dislikes",
];
const LABELS: Record<ImportDraftCategory, string> = {
    playlists: "Плейлисты",
    likes: "Любимые треки",
    albums: "Альбомы",
    artists: "Исполнители",
    dislikes: "Нежелательные треки",
};
const ACTIVE = new Set([
    "previewing",
    "pending",
    "creating_playlist",
    "cancelling",
]);
const BUTTON =
    "inline-flex min-h-11 items-center justify-center rounded-xl border border-line px-4 py-2 text-sm font-semibold text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50";
const INPUT =
    "min-h-11 w-full rounded-xl border border-line bg-surface-elevated px-3 py-2 text-base text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light sm:text-sm";
function failureMessage(error: unknown): string {
    const key = error instanceof Error ? error.message : "";
    const labels: Record<string, string> = {
        import_file_too_large: "Размер файла не должен превышать 512 КиБ.",
        import_file_too_many_entries:
            "В одном импорте допускается не более 1000 записей.",
        import_file_too_many_groups:
            "В одном импорте допускается не более 100 плейлистов.",
        import_file_invalid: "Проверьте формат текста или Spotify JSON.",
        import_file_empty: "В файле нет записей для импорта.",
        import_draft_forbidden:
            "Этот черновик принадлежит другой учётной записи.",
        import_draft_not_found: "Черновик не найден.",
        import_draft_revision_conflict:
            "Черновик изменился. Обновите состояние и выберите категории заново.",
        import_source_identity_invalid:
            "В файле есть неподдерживаемая ссылка на запись.",
    };
    return (
        labels[key] ??
        "Не удалось завершить действие. Обновите состояние или повторите попытку."
    );
}
function checkedJob(job: ImportDraftJob): ImportDraftJob {
    if (
        !job ||
        typeof job.id !== "string" ||
        !Number.isInteger(job.draftRevision) ||
        job.draftRevision < 1 ||
        job.draftData?.version !== 1 ||
        !Array.isArray(job.draftData.normalized?.entries) ||
        job.draftData.normalized.entries.length > 1000 ||
        !Array.isArray(job.draftData.normalized.groups)
    )
        throw Error("import_draft_response_invalid");
    return job;
}
function selection(
    job: ImportDraftJob,
    categories: ImportDraftCategory[],
): ImportDraftConfirmation {
    const preview = job.draftData.preview;
    if (!preview || !/^[a-f0-9]{64}$/.test(preview.mappingDigest))
        throw Error("import_draft_response_invalid");
    return {
        revision: job.draftRevision,
        previewRevision: preview.previewRevision,
        mappingDigest: preview.mappingDigest,
        categories: [...categories],
    };
}

/** Owner-bound file preview and explicit confirmation on the existing import journal. */
export function ImportDraftFlow({
    initialDraftId,
    onDraftCreated,
    onReset,
}: {
    initialDraftId?: string | null;
    onDraftCreated?: (id: string) => void;
    onReset?: () => void;
}) {
    const queryClient = useQueryClient();
    const fieldId = useId();
    const lease = useRef(getAuthRuntimeLease());
    const mounted = useRef(false),
        sequence = useRef(0),
        lifecycle = useRef(0),
        busyRef = useRef(false),
        readingGeneration = useRef(0),
        polling = useRef(false);
    const currentJob = useRef<ImportDraftJob | null>(null);
    const confirmation = useRef<ImportDraftConfirmation | null>(null);
    const routeDraft = useRef<string | null>(null);
    const completed = useRef(new Set<string>());
    const [job, setJob] = useState<ImportDraftJob | null>(null);
    const [format, setFormat] = useState<ImportDraftUpload["format"]>("text");
    const [textCategory, setTextCategory] = useState<
        "playlists" | "likes" | "dislikes"
    >("playlists");
    const [content, setContent] = useState(""),
        [name, setName] = useState(""),
        [fileName, setFileName] = useState("");
    const [categories, setCategories] = useState<ImportDraftCategory[]>([]);
    const [submittedSelection, setSubmittedSelection] =
        useState<ImportDraftConfirmation | null>(null);
    const [busy, setBusy] = useState(false),
        [reading, setReading] = useState(false),
        [editing, setEditing] = useState(false),
        [retired, setRetired] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const live = useCallback(
        () =>
            mounted.current &&
            !lease.current.signal.aborted &&
            lease.current.generation === getAuthRuntimeGeneration(),
        [],
    );
    const clearDraft = useCallback(() => {
        sequence.current++;
        readingGeneration.current++;
        busyRef.current = false;
        currentJob.current = null;
        confirmation.current = null;
        setJob(null);
        setContent("");
        setName("");
        setFileName("");
        setCategories([]);
        setSubmittedSelection(null);
        setFailure(null);
        setBusy(false);
        setReading(false);
        setEditing(false);
    }, []);

    useEffect(() => {
        mounted.current = true;
        lifecycle.current++;
        const revoke = () => {
            sequence.current++;
            readingGeneration.current++;
            busyRef.current = false;
            currentJob.current = null;
            confirmation.current = null;
            setJob(null);
            setContent("");
            setName("");
            setFileName("");
            setCategories([]);
            setSubmittedSelection(null);
            setFailure(null);
            setBusy(false);
            setReading(false);
            setRetired(true);
        };
        lease.current.signal.addEventListener("abort", revoke);
        return () => {
            mounted.current = false;
            lifecycle.current++;
            sequence.current++;
            readingGeneration.current++;
            busyRef.current = false;
            polling.current = false;
            lease.current.signal.removeEventListener("abort", revoke);
        };
    }, []);

    const apply = useCallback(
        (incoming: ImportDraftJob) => {
            if (!live()) return;
            const next = checkedJob(incoming),
                previous = currentJob.current;
            if (next.confirmedSnapshot) {
                confirmation.current = {
                    revision: next.confirmedSnapshot.revision,
                    previewRevision: next.confirmedSnapshot.previewRevision,
                    mappingDigest: next.confirmedSnapshot.mappingDigest,
                    categories: [...next.confirmedSnapshot.categories],
                };
                setSubmittedSelection(confirmation.current);
                setCategories(next.confirmedSnapshot.categories);
            } else if (
                previous?.draftRevision !== next.draftRevision ||
                previous?.draftData.preview?.previewRevision !==
                    next.draftData.preview?.previewRevision
            ) {
                confirmation.current = null;
                setSubmittedSelection(null);
                setCategories([]);
            }
            currentJob.current = next;
            setJob(next);
            if (
                next.status === "completed" &&
                next.draftResult?.version === 1 &&
                !completed.current.has(next.id)
            ) {
                completed.current.add(next.id);
                for (const queryKey of [
                    queryKeys.playlists(),
                    queryKeys.likedPlaylistAll(),
                    queryKeys.savedMusicAll(),
                    queryKeys.personalizedHomeAll(),
                    queryKeys.mixes(),
                ])
                    void queryClient.invalidateQueries({ queryKey });
                if (next.draftResult.likes || next.draftResult.dislikes)
                    void invalidatePersonalSearch(queryClient);
                if (next.draftResult.albums || next.draftResult.artists)
                    void invalidatePersonalSearch(queryClient, "saved");
                window.dispatchEvent(new CustomEvent("notifications-changed"));
                if (next.draftResult.playlistIds.length)
                    window.dispatchEvent(new CustomEvent("playlist-created"));
            }
            window.dispatchEvent(
                new CustomEvent("import-jobs-changed", {
                    detail: { jobId: next.id },
                }),
            );
        },
        [live, queryClient],
    );

    const run = useCallback(
        async (action: (check: () => boolean) => Promise<void>) => {
            if (!live() || busyRef.current) return;
            const generation = ++sequence.current,
                life = lifecycle.current;
            const check = () =>
                live() &&
                sequence.current === generation &&
                lifecycle.current === life;
            busyRef.current = true;
            setBusy(true);
            setFailure(null);
            try {
                await action(check);
            } catch (error) {
                if (check()) setFailure(failureMessage(error));
            } finally {
                if (check()) {
                    busyRef.current = false;
                    setBusy(false);
                }
            }
        },
        [live],
    );

    useEffect(() => {
        const previousRoute = routeDraft.current;
        routeDraft.current = initialDraftId ?? null;
        if (!initialDraftId) {
            if (previousRoute) clearDraft();
            return;
        }
        if (currentJob.current?.id === initialDraftId) return;
        clearDraft();
        void run(async (check) => {
            if (initialDraftId.length > 128)
                throw Error("import_draft_not_found");
            const response = await api.getImportDraft(initialDraftId);
            if (check()) {
                apply(response.job);
                setName(response.job.draftData.normalized.name);
                setFormat(response.job.draftData.normalized.format);
                const category =
                    response.job.draftData.normalized.entries[0]?.category;
                setTextCategory(
                    category === "likes" || category === "dislikes"
                        ? category
                        : "playlists",
                );
            }
        });
    }, [initialDraftId, apply, run, clearDraft]);

    const refresh = useCallback(async () => {
        const id = currentJob.current?.id;
        if (!id || !live() || busyRef.current || polling.current) return;
        const generation = sequence.current,
            life = lifecycle.current;
        polling.current = true;
        try {
            const response = await api.getImportDraft(id);
            if (
                live() &&
                sequence.current === generation &&
                lifecycle.current === life &&
                currentJob.current?.id === id
            ) {
                apply(response.job);
                setFailure(null);
            }
        } catch (error) {
            if (
                live() &&
                sequence.current === generation &&
                lifecycle.current === life
            )
                setFailure(failureMessage(error));
        } finally {
            if (lifecycle.current === life) polling.current = false;
        }
    }, [apply, live]);
    useVisibilityGatedInterval(() => void refresh(), 2000, {
        enabled: Boolean(
            job &&
            (ACTIVE.has(job.status) ||
                (submittedSelection && job.status === "awaiting_confirmation")),
        ),
    });

    const readFile = async (file: File | undefined) => {
        if (!file || !live() || busyRef.current) return;
        const generation = ++readingGeneration.current;
        setContent("");
        setFileName("");
        setFailure(null);
        setReading(true);
        try {
            if (file.size > MAX_FILE_BYTES)
                throw Error("import_file_too_large");
            let decoded: string;
            try {
                decoded = new TextDecoder("utf-8", { fatal: true }).decode(
                    await file.arrayBuffer(),
                );
            } catch {
                throw Error("invalid_utf8");
            }
            if (!live() || generation !== readingGeneration.current) return;
            if (new TextEncoder().encode(decoded).byteLength > MAX_FILE_BYTES)
                throw Error("import_file_too_large");
            setContent(decoded);
            setFileName(file.name);
            setFormat(/\.json$/i.test(file.name) ? "spotify-json" : "text");
            const suggested = file.name.replace(/\.(txt|json)$/i, "");
            if (suggested.length <= 200) setName(suggested);
        } catch (error) {
            if (live() && generation === readingGeneration.current)
                setFailure(
                    error instanceof Error && error.message === "invalid_utf8"
                        ? "Файл должен содержать корректный UTF-8."
                        : failureMessage(error),
                );
        } finally {
            if (live() && generation === readingGeneration.current)
                setReading(false);
        }
    };
    const prepare = () =>
        run(async (check) => {
            if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES)
                throw Error("import_file_too_large");
            const input: ImportDraftUpload = {
                format,
                content,
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(format === "text" ? { textCategory } : {}),
            };
            const previous = currentJob.current;
            const created =
                previous && editing
                    ? await api.updateImportDraft(previous.id, {
                          ...input,
                          revision: previous.draftRevision,
                      })
                    : await api.createImportDraft(input);
            if (!check()) return;
            apply(created.job);
            setEditing(false);
            onDraftCreated?.(created.job.id);
            const response = await api.previewImportDraft(
                created.job.id,
                created.job.draftRevision,
            );
            if (check()) apply(response.job);
        });
    const confirm = () =>
        run(async (check) => {
            const previous = currentJob.current;
            if (!previous) return;
            const input =
                confirmation.current ??
                selection(
                    previous,
                    CATEGORIES.filter((c) => categories.includes(c)),
                );
            confirmation.current = input;
            setSubmittedSelection(input);
            const response = await api.confirmImportDraft(previous.id, input);
            if (check()) apply(response.job);
        });
    const cancel = () =>
        run(async (check) => {
            const previous = currentJob.current;
            if (!previous) return;
            const response = await api.cancelImportJob(previous.id);
            if (check()) apply(response.job as ImportDraftJob);
        });
    const retryPreview = () =>
        run(async (check) => {
            const previous = currentJob.current;
            if (!previous) return;
            const response = await api.previewImportDraft(
                previous.id,
                previous.draftRevision,
            );
            if (check()) apply(response.job);
        });
    const reset = () => {
        if (!live() || busyRef.current) return;
        sequence.current++;
        readingGeneration.current++;
        currentJob.current = null;
        confirmation.current = null;
        setJob(null);
        setCategories([]);
        setSubmittedSelection(null);
        setContent("");
        setName("");
        setFileName("");
        setFailure(null);
        setEditing(false);
        onReset?.();
    };
    if (retired)
        return (
            <p role="status" className="text-sm text-content-muted">
                Сессия изменилась. Откройте импорт из текущей учётной записи.
            </p>
        );
    const normalized = job?.draftData.normalized,
        preview = job?.draftData.preview;
    const rows = new Map(preview?.rows.map((row) => [row.entryId, row]));
    const groups = new Map(
        normalized?.groups.map((group) => [group.id, group.name]),
    );
    const frozen = Boolean(submittedSelection || job?.confirmedSnapshot);
    const canConfirm =
        Boolean(job?.status === "awaiting_confirmation" && preview) ||
        Boolean(job?.status === "failed" && job.confirmedSnapshot);
    return (
        <section
            aria-label="Импорт текстового или Spotify файла"
            className="space-y-5"
        >
            <p className="text-sm leading-6 text-content-muted">
                Предпросмотр сохраняет порядок, повторы и неразрешённые записи.
                Вы сами выбираете категории. Импорт не запускает загрузку аудио
                и не меняет исходную коллекцию Spotify.
            </p>
            {failure && (
                <p
                    role="alert"
                    className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-content"
                >
                    {failure}
                </p>
            )}
            {(!job || editing) && (
                <div className="space-y-4">
                    <label
                        className="block text-sm text-content"
                        htmlFor={fieldId + "-file"}
                    >
                        Файл TXT или Spotify JSON · до 512 КиБ
                    </label>
                    <input
                        id={fieldId + "-file"}
                        type="file"
                        accept=".txt,.json,text/plain,application/json"
                        disabled={busy}
                        onChange={(event) =>
                            void readFile(event.target.files?.[0])
                        }
                        className="block min-h-11 w-full text-sm text-content file:mr-3 file:min-h-11 file:rounded-xl file:border-0 file:bg-surface-elevated file:px-4 file:text-content"
                    />
                    {fileName && (
                        <p className="break-words text-xs text-content-muted">
                            {fileName}
                        </p>
                    )}
                    {reading && (
                        <p role="status" className="text-sm text-content-muted">
                            Читаем файл…
                        </p>
                    )}
                    <label
                        className="block text-sm text-content"
                        htmlFor={fieldId + "-format"}
                    >
                        Формат
                    </label>
                    <select
                        id={fieldId + "-format"}
                        value={format}
                        disabled={busy || reading}
                        onChange={(e) =>
                            setFormat(
                                e.target.value as ImportDraftUpload["format"],
                            )
                        }
                        className={INPUT}
                    >
                        <option value="text">Текстовый список</option>
                        <option value="spotify-json">
                            Spotify JSON-экспорт
                        </option>
                    </select>
                    {format === "text" && (
                        <>
                            <label
                                className="block text-sm text-content"
                                htmlFor={fieldId + "-intent"}
                            >
                                Что содержит текст
                            </label>
                            <select
                                id={fieldId + "-intent"}
                                value={textCategory}
                                disabled={busy || reading}
                                onChange={(e) =>
                                    setTextCategory(
                                        e.target.value as typeof textCategory,
                                    )
                                }
                                className={INPUT}
                            >
                                <option value="playlists">
                                    Список для плейлиста
                                </option>
                                <option value="likes">Любимые треки</option>
                                <option value="dislikes">
                                    Нежелательные треки
                                </option>
                            </select>
                        </>
                    )}
                    <label
                        className="block text-sm text-content"
                        htmlFor={fieldId + "-name"}
                    >
                        Название импорта
                    </label>
                    <input
                        id={fieldId + "-name"}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={busy || reading}
                        className={INPUT}
                    />
                    <label
                        className="block text-sm text-content"
                        htmlFor={fieldId + "-content"}
                    >
                        Содержимое файла или текст
                    </label>
                    <textarea
                        id={fieldId + "-content"}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        disabled={busy || reading}
                        rows={7}
                        className={INPUT}
                        placeholder="Исполнитель - Название трека"
                    />
                    <p className="text-xs leading-5 text-content-muted">
                        До 1000 записей и 100 плейлистов. Для точного
                        нежелательного трека текст может содержать ссылку yt:ID
                        или library:ID, затем табуляцию, исполнителя и название.
                        Совпадение по названию само по себе не создаёт запрет.
                    </p>
                    <button
                        type="button"
                        disabled={busy || reading || !content.trim()}
                        onClick={() => void prepare()}
                        className={BUTTON + " w-full bg-brand text-surface"}
                    >
                        {busy ? "Сохраняем черновик…" : "Сопоставить"}
                    </button>
                </div>
            )}
            {job && !editing && (
                <>
                    <div className="border-y border-line py-4">
                        <h2 className="break-words text-lg font-bold text-content">
                            {job.playlistName}
                        </h2>
                        <p
                            role="status"
                            className="mt-1 text-sm text-content-muted"
                        >
                            {job.status === "previewing"
                                ? "Сопоставляем записи…"
                                : job.status === "awaiting_confirmation"
                                  ? "Предпросмотр готов. Выберите категории для импорта."
                                  : job.status === "completed" &&
                                      job.draftResult
                                    ? "Импорт завершён"
                                    : job.status === "cancelled"
                                      ? "Импорт отменён"
                                      : job.status === "cancelling"
                                        ? "Отменяем импорт…"
                                        : job.status === "failed"
                                          ? "Импорт не выполнен. Сохранённое состояние доступно для повторной попытки."
                                          : "Состояние сохранено. Импорт выполняется в фоне."}
                        </p>
                    </div>
                    {preview && job.status !== "completed" && (
                        <>
                            <fieldset
                                disabled={
                                    busy ||
                                    frozen ||
                                    job.status !== "awaiting_confirmation"
                                }
                                className="space-y-3"
                            >
                                <legend className="mb-3 font-semibold text-content">
                                    Что импортировать
                                </legend>
                                {CATEGORIES.filter((category) =>
                                    normalized?.entries.some(
                                        (entry) => entry.category === category,
                                    ),
                                ).map((category) => (
                                    <label
                                        key={category}
                                        className="flex min-h-11 items-center gap-3 rounded-xl border border-line px-3 text-sm text-content"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={categories.includes(
                                                category,
                                            )}
                                            disabled={
                                                busy ||
                                                frozen ||
                                                job.status !==
                                                    "awaiting_confirmation"
                                            }
                                            onChange={(e) =>
                                                setCategories((old) =>
                                                    e.target.checked
                                                        ? [...old, category]
                                                        : old.filter(
                                                              (c) =>
                                                                  c !==
                                                                  category,
                                                          ),
                                                )
                                            }
                                            className="h-5 w-5 accent-brand"
                                        />
                                        {LABELS[category]}{" "}
                                        <span className="ml-auto tabular-nums text-content-muted">
                                            {
                                                normalized!.entries.filter(
                                                    (entry) =>
                                                        entry.category ===
                                                        category,
                                                ).length
                                            }
                                        </span>
                                    </label>
                                ))}
                            </fieldset>
                            <p className="text-xs text-content-muted">
                                Ничего не выбрано автоматически. Нежелательные
                                треки применяются только по точной
                                поддерживаемой ссылке; остальные остаются
                                неразрешёнными.
                            </p>
                            <ol
                                aria-label="Исходный порядок записей"
                                className="max-h-96 divide-y divide-line overflow-y-auto rounded-xl border border-line"
                            >
                                {normalized!.entries.map((entry) => {
                                    const row = rows.get(entry.id),
                                        unresolved = row?.unresolvedReason;
                                    return (
                                        <li
                                            key={entry.id}
                                            data-import-entry={entry.id}
                                            className="space-y-1 p-3 text-sm"
                                        >
                                            <p className="break-words text-content">
                                                {entry.position + 1}.{" "}
                                                {entry.artist
                                                    ? entry.artist + " — "
                                                    : ""}
                                                {entry.title}
                                            </p>
                                            <p className="text-xs text-content-muted">
                                                {LABELS[entry.category]}
                                                {entry.groupId
                                                    ? " · " +
                                                      groups.get(entry.groupId)
                                                    : ""}{" "}
                                                · Уверенность:{" "}
                                                {row?.confidence ?? 0}%
                                            </p>
                                            <p className="text-xs text-content-muted">
                                                {unresolved ===
                                                "exact_negative_unavailable"
                                                    ? "Для негативного предпочтения нет точной поддерживаемой ссылки. Запрет не будет создан."
                                                    : unresolved
                                                      ? "Не разрешено: исходная позиция будет сохранена."
                                                      : entry.category ===
                                                              "albums" ||
                                                          entry.category ===
                                                              "artists"
                                                        ? "Сохраняется исходная ссылка Spotify."
                                                        : row?.match?.source ===
                                                            "local"
                                                          ? "Совпадение в библиотеке"
                                                          : row?.match
                                                                  ?.source ===
                                                              "youtube"
                                                            ? "Совпадение YouTube"
                                                            : "Совпадение не найдено"}
                                            </p>
                                        </li>
                                    );
                                })}
                            </ol>
                        </>
                    )}
                    {job.status === "completed" && job.draftResult && (
                        <div className="space-y-2 text-sm text-content">
                            <p>
                                Плейлисты: {job.draftResult.playlistIds.length}{" "}
                                · Любимые: {job.draftResult.likes} · Альбомы:{" "}
                                {job.draftResult.albums} · Исполнители:{" "}
                                {job.draftResult.artists} · Нежелательные:{" "}
                                {job.draftResult.dislikes}
                            </p>
                            <p>
                                Неразрешённые позиции:{" "}
                                {job.draftResult.unresolved.length}. Конфликты с
                                существующим выбором:{" "}
                                {job.draftResult.skipped.length}.
                            </p>
                            {job.draftResult.playlistIds.map((id) => (
                                <a
                                    key={id}
                                    href={"/playlist/" + encodeURIComponent(id)}
                                    className="inline-flex min-h-11 items-center text-brand"
                                >
                                    Открыть плейлист
                                </a>
                            ))}
                        </div>
                    )}
                    <div className="flex flex-wrap gap-3">
                        {canConfirm && (
                            <button
                                type="button"
                                onClick={() => void confirm()}
                                disabled={
                                    busy || (!frozen && categories.length === 0)
                                }
                                className={BUTTON + " bg-brand text-surface"}
                            >
                                {submittedSelection
                                    ? "Повторить подтверждение"
                                    : "Подтвердить импорт"}
                            </button>
                        )}
                        {(job.status === "draft" || job.status === "failed") &&
                            !job.confirmedSnapshot && (
                                <button
                                    type="button"
                                    className={BUTTON}
                                    disabled={busy}
                                    onClick={() => void retryPreview()}
                                >
                                    {job.status === "draft"
                                        ? "Сопоставить записи"
                                        : "Повторить сопоставление"}
                                </button>
                            )}
                        {!job.confirmedSnapshot &&
                            !submittedSelection &&
                            [
                                "draft",
                                "awaiting_confirmation",
                                "failed",
                            ].includes(job.status) && (
                                <button
                                    type="button"
                                    className={BUTTON}
                                    disabled={busy}
                                    onClick={() => {
                                        setEditing(true);
                                        setCategories([]);
                                    }}
                                >
                                    Изменить источник
                                </button>
                            )}
                        {[
                            "draft",
                            "previewing",
                            "awaiting_confirmation",
                            "pending",
                            "creating_playlist",
                            "cancelling",
                        ].includes(job.status) && (
                            <button
                                type="button"
                                className={BUTTON}
                                disabled={busy || job.status === "cancelling"}
                                onClick={() => void cancel()}
                            >
                                Отменить импорт
                            </button>
                        )}
                        <button
                            type="button"
                            className={BUTTON}
                            disabled={busy}
                            onClick={() => void refresh()}
                        >
                            Обновить состояние
                        </button>
                        {["completed", "cancelled"].includes(job.status) && (
                            <button
                                type="button"
                                className={BUTTON}
                                onClick={reset}
                            >
                                Другой файл
                            </button>
                        )}
                    </div>
                </>
            )}
        </section>
    );
}
