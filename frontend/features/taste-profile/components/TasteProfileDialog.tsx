"use client";

import {
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type FormEvent,
} from "react";
import { Check, LoaderCircle, Search, X } from "lucide-react";
import { nextFocusIndex } from "@/components/ui/focusTrapMath";
import { CachedImage } from "@/components/ui/CachedImage";
import { useTasteArtistArtwork } from "../hooks/useTasteArtistArtwork";
import { cn } from "@/utils/cn";
import {
    addTasteLabel,
    isTasteLabelSelected,
    normalizeTasteProfileSelection,
    toggleTasteLabel,
    validateTasteProfileSelection,
} from "../model";
import { GENRE_GROUPS, suggestArtistsForGenres } from "../suggestions";
import {
    useCanonicalArtistSearch,
    type CanonicalArtistSearchResult,
} from "../hooks/useCanonicalArtistSearch";
import type { TasteProfileSelection } from "../types";

type TasteProfileDialogMode = "onboarding" | "edit";

export interface TasteProfileDialogProps {
    mode: TasteProfileDialogMode;
    initialSelection: TasteProfileSelection;
    isSaving: boolean;
    error: string | null;
    onSave: (selection: TasteProfileSelection) => Promise<unknown>;
    onSkip?: () => Promise<unknown>;
    onClose: () => void;
}

const FOCUSABLE_SELECTOR =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function selectionSummary(selection: TasteProfileSelection): string {
    const labels = [...selection.genres, ...selection.artists];
    if (labels.length === 0) return "Пока ничего не выбрано";
    const visible = labels.slice(0, 4).join(" · ");
    const hiddenCount = labels.length - 4;
    return hiddenCount > 0 ? `${visible} · ещё ${hiddenCount}` : visible;
}

function artistOptionId(mbid: string): string {
    return `taste-artist-option-${mbid}`;
}

/** Accessible mobile sheet / desktop dialog for first-run and later taste editing. */
export function TasteProfileDialog({
    mode,
    initialSelection,
    isSaving,
    error,
    onSave,
    onSkip,
    onClose,
}: TasteProfileDialogProps) {
    const [selection, setSelection] = useState(() =>
        normalizeTasteProfileSelection(initialSelection),
    );
    const [artistSearch, setArtistSearch] = useState("");
    const [artistGenre, setArtistGenre] = useState("all");
    const [artistLimit, setArtistLimit] = useState(24);
    const [activeArtistIndex, setActiveArtistIndex] = useState(-1);
    const [localError, setLocalError] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    const savingRef = useRef(isSaving);
    const submissionRef = useRef<"save" | "skip" | null>(null);
    const titleId = useId();
    const descriptionId = useId();
    const validation = useMemo(
        () => validateTasteProfileSelection(selection),
        [selection],
    );
    const count = validation.count;
    const suggestedArtists = useMemo(
        () =>
            normalizeTasteProfileSelection({
                genres: [],
                artists: [
                    ...suggestArtistsForGenres(
                        artistGenre === "selected"
                            ? selection.genres
                            : artistGenre === "all"
                              ? []
                              : [artistGenre],
                        1000,
                    ),
                ],
            }).artists,
        [selection.genres, artistGenre],
    );
    const canonicalArtistSearch = useCanonicalArtistSearch(artistSearch);
    const visibleArtists = suggestedArtists.slice(0, artistLimit);
    const artwork = useTasteArtistArtwork(
        canonicalArtistSearch.hasQuery ? [] : visibleArtists,
    );
    const activeArtist = canonicalArtistSearch.results[activeArtistIndex];

    useEffect(() => {
        setActiveArtistIndex(canonicalArtistSearch.results.length > 0 ? 0 : -1);
    }, [canonicalArtistSearch.results]);

    useEffect(() => {
        closeRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        savingRef.current = isSaving;
    }, [isSaving]);

    useEffect(() => {
        const previouslyFocused =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        dialogRef.current?.focus();

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                if (mode === "edit" && !savingRef.current) {
                    event.preventDefault();
                    closeRef.current();
                }
                return;
            }
            if (event.key !== "Tab" || !dialogRef.current) return;
            const focusable = Array.from(
                dialogRef.current.querySelectorAll<HTMLElement>(
                    FOCUSABLE_SELECTOR,
                ),
            );
            const currentIndex = focusable.indexOf(
                document.activeElement as HTMLElement,
            );
            const targetIndex = nextFocusIndex(
                focusable.length,
                currentIndex,
                event.shiftKey,
            );
            event.preventDefault();
            if (targetIndex < 0) dialogRef.current.focus();
            else focusable[targetIndex]?.focus();
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.body.style.overflow = previousOverflow;
            if (previouslyFocused?.isConnected) previouslyFocused.focus();
        };
    }, [mode]);

    const updateChoice = (kind: "genres" | "artists", label: string) => {
        if (
            kind === "genres" &&
            artistGenre === "selected" &&
            selection.genres.length === 1 &&
            isTasteLabelSelected(selection.genres, label)
        ) {
            setArtistGenre("all");
        }
        setSelection(
            (current) => toggleTasteLabel(current, kind, label).selection,
        );
        setLocalError(null);
    };
    const selectCanonicalArtist = (artist: CanonicalArtistSearchResult) => {
        const result = addTasteLabel(selection, "artists", artist.name);
        setSelection(result.selection);
        setLocalError(result.error);
        if (!result.error) {
            setArtistSearch("");
            setActiveArtistIndex(-1);
        }
    };
    const submitCustomArtist = (event: FormEvent) => {
        event.preventDefault();
        if (activeArtist) selectCanonicalArtist(activeArtist);
    };
    const save = async () => {
        if (submissionRef.current) return;
        if (validation.code !== "valid") {
            setLocalError(validation.message);
            return;
        }
        setLocalError(null);
        submissionRef.current = "save";
        try {
            await onSave(normalizeTasteProfileSelection(selection));
        } catch {
            // The mutation error is rendered from the controlled `error` prop.
        } finally {
            submissionRef.current = null;
        }
    };
    const skip = async () => {
        if (!onSkip || submissionRef.current) return;
        setLocalError(null);
        submissionRef.current = "skip";
        try {
            await onSkip();
        } catch {
            // The mutation error is rendered from the controlled `error` prop.
        } finally {
            submissionRef.current = null;
        }
    };
    const visibleError = localError ?? error;
    const changeGenre = (genre: string) => {
        setArtistGenre(genre);
        setArtistLimit(24);
        setArtistSearch("");
        if (resultsRef.current) resultsRef.current.scrollTop = 0;
    };

    return (
        <div
            className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/80 sm:p-5"
            role="presentation"
            onMouseDown={(event) => {
                if (
                    event.target === event.currentTarget &&
                    mode === "edit" &&
                    !isSaving
                )
                    onClose();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                data-testid="taste-profile-dialog"
                data-taste-stage="artists"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                aria-busy={isSaving}
                tabIndex={-1}
                className="relative flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden bg-surface-raised text-content shadow-2xl focus:outline-none sm:max-h-[min(92dvh,58rem)] sm:max-w-7xl sm:rounded-3xl sm:border sm:border-white/10 lg:grid lg:grid-cols-[19rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]"
            >
                {mode === "edit" && (
                    <button
                        type="button"
                        disabled={isSaving}
                        onClick={onClose}
                        aria-label="Закрыть настройку вкусов"
                        className="absolute right-3 top-[max(0.75rem,var(--safe-area-top))] z-10 grid h-11 w-11 place-items-center rounded-full bg-surface-raised text-content-secondary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light sm:top-3"
                    >
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                )}
                <header className="shrink-0 px-5 pb-3 pr-16 pt-[max(1.5rem,var(--safe-area-top))] sm:px-7 sm:pr-16 lg:overflow-y-auto lg:pb-8 lg:pr-5 lg:pt-12">
                    <h2
                        id={titleId}
                        className="max-w-sm text-2xl font-black leading-tight tracking-tight sm:text-3xl lg:text-4xl"
                    >
                        Выберите любимых исполнителей
                    </h2>
                    <p
                        id={descriptionId}
                        className="mt-3 max-w-sm text-sm leading-6 text-content-secondary"
                    >
                        Это поможет получить более точные и интересные
                        рекомендации.
                    </p>
                    <p className="mt-4 hidden text-xs leading-5 text-content-muted lg:block">
                        Ваш выбор помогает настроить рекомендации на главной.
                        Прослушивания и лайки уточняют их дальше. Настройка не
                        ставит лайки автоматически.
                    </p>
                    <div
                        className="mt-5 hidden lg:block"
                        aria-label="Ваш выбор"
                    >
                        <p className="mb-2 text-xs font-semibold text-content-muted">
                            Ваш выбор
                        </p>
                        <p className="text-sm leading-6 text-content-secondary">
                            {selectionSummary(selection)}
                        </p>
                    </div>
                </header>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:row-span-2 lg:pt-16">
                    <div
                        data-testid="taste-profile-controls"
                        className="shrink-0 border-b border-white/10 px-5 pb-4 sm:px-7"
                    >
                        <label className="mb-3 block text-xs font-semibold text-content-secondary">
                            Жанр исполнителей
                            <select
                                aria-label="Жанр исполнителей"
                                value={artistGenre}
                                disabled={isSaving}
                                onChange={(event) =>
                                    changeGenre(event.target.value)
                                }
                                className="mt-2 block min-h-11 w-full rounded-xl border border-white/15 bg-surface-raised px-3 text-sm text-content outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                            >
                                <option value="all">Все исполнители</option>
                                {selection.genres.length > 0 && (
                                    <option value="selected">
                                        По сохранённым жанрам
                                    </option>
                                )}
                                {GENRE_GROUPS.map((group) => (
                                    <optgroup
                                        key={group.label}
                                        label={group.label}
                                    >
                                        {group.genres.map((genre) => (
                                            <option key={genre} value={genre}>
                                                {genre}
                                            </option>
                                        ))}
                                    </optgroup>
                                ))}
                            </select>
                        </label>
                        <form
                            onSubmit={submitCustomArtist}
                            className="relative"
                        >
                            <Search
                                className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted"
                                aria-hidden="true"
                            />
                            <input
                                type="search"
                                value={artistSearch}
                                disabled={isSaving}
                                onChange={(event) => {
                                    setArtistSearch(event.target.value);
                                    setActiveArtistIndex(-1);
                                    setLocalError(null);
                                }}
                                onKeyDown={(event) => {
                                    const resultCount =
                                        canonicalArtistSearch.results.length;
                                    if (
                                        event.key === "ArrowDown" &&
                                        resultCount > 0
                                    ) {
                                        event.preventDefault();
                                        setActiveArtistIndex((current) =>
                                            current < 0
                                                ? 0
                                                : (current + 1) % resultCount,
                                        );
                                    } else if (
                                        event.key === "ArrowUp" &&
                                        resultCount > 0
                                    ) {
                                        event.preventDefault();
                                        setActiveArtistIndex((current) =>
                                            current <= 0
                                                ? resultCount - 1
                                                : current - 1,
                                        );
                                    } else if (
                                        event.key === "Enter" &&
                                        activeArtist
                                    ) {
                                        event.preventDefault();
                                        selectCanonicalArtist(activeArtist);
                                    } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        setArtistSearch("");
                                        setActiveArtistIndex(-1);
                                    }
                                }}
                                aria-label="Найти или добавить артиста"
                                placeholder="Имя артиста или группы"
                                maxLength={80}
                                autoComplete="off"
                                role="combobox"
                                aria-autocomplete="list"
                                aria-controls="taste-artist-results"
                                aria-expanded={canonicalArtistSearch.hasQuery}
                                aria-activedescendant={
                                    activeArtist
                                        ? artistOptionId(activeArtist.mbid)
                                        : undefined
                                }
                                className="min-h-12 w-full rounded-2xl border border-white/10 bg-black/25 py-3 pl-11 pr-4 text-sm text-content outline-none transition-colors placeholder:text-content-muted hover:border-white/20 focus:border-brand/60 focus:ring-2 focus:ring-brand/20 disabled:opacity-55 motion-reduce:transition-none"
                            />
                        </form>
                    </div>
                    <div
                        ref={resultsRef}
                        data-testid="taste-profile-scroll-region"
                        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-4 sm:px-7"
                    >
                        <p
                            className="mb-4 text-xs text-content-muted"
                            aria-live="polite"
                        >
                            {canonicalArtistSearch.hasQuery
                                ? "Результаты поиска по всему каталогу"
                                : `${artistGenre === "all" ? "Разные направления" : artistGenre === "selected" ? "По вашим жанрам" : artistGenre} · ${suggestedArtists.length} исполнителей`}
                        </p>
                        {!canonicalArtistSearch.hasQuery ? (
                            <>
                                <div
                                    className="grid grid-cols-3 gap-x-4 gap-y-6 pt-2 sm:grid-cols-4 lg:grid-cols-5"
                                    aria-label="Исполнители"
                                >
                                    {visibleArtists.map((artist) => {
                                        const selected = isTasteLabelSelected(
                                            selection.artists,
                                            artist,
                                        );
                                        return (
                                            <button
                                                type="button"
                                                key={artist}
                                                aria-label={artist}
                                                aria-pressed={selected}
                                                disabled={isSaving}
                                                onClick={() =>
                                                    updateChoice(
                                                        "artists",
                                                        artist,
                                                    )
                                                }
                                                className="group min-w-0 rounded-xl text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-50"
                                            >
                                                <span
                                                    className={cn(
                                                        "relative mx-auto block aspect-square w-full rounded-full border-[3px] p-1 transition-[border-color,transform] group-hover:scale-[1.025] motion-reduce:transform-none motion-reduce:transition-none",
                                                        selected
                                                            ? "border-brand"
                                                            : "border-transparent",
                                                    )}
                                                >
                                                    <span className="relative block h-full w-full overflow-hidden rounded-full bg-surface-highlight">
                                                        <CachedImage
                                                            src={
                                                                artwork[artist]
                                                            }
                                                            alt=""
                                                            fill
                                                            sizes="(max-width: 639px) 28vw, 150px"
                                                            className="object-cover"
                                                            fallback={
                                                                <span
                                                                    aria-hidden="true"
                                                                    className="flex h-full items-center justify-center text-2xl font-semibold text-content-muted"
                                                                >
                                                                    {artist
                                                                        .split(
                                                                            /\s+/,
                                                                        )
                                                                        .slice(
                                                                            0,
                                                                            2,
                                                                        )
                                                                        .map(
                                                                            (
                                                                                word,
                                                                            ) =>
                                                                                word[0],
                                                                        )
                                                                        .join(
                                                                            "",
                                                                        )}
                                                                </span>
                                                            }
                                                        />
                                                    </span>
                                                    {selected && (
                                                        <span className="absolute bottom-1 right-1 grid h-7 w-7 place-items-center rounded-full border-[3px] border-surface-raised bg-brand text-black">
                                                            <Check
                                                                className="h-4 w-4"
                                                                aria-hidden="true"
                                                            />
                                                        </span>
                                                    )}
                                                </span>
                                                <span className="mt-2 block break-words text-xs font-semibold leading-5 sm:text-sm">
                                                    {artist}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                                {suggestedArtists.length > artistLimit && (
                                    <button
                                        type="button"
                                        disabled={isSaving}
                                        onClick={() =>
                                            setArtistLimit(
                                                (current) => current + 24,
                                            )
                                        }
                                        className="mx-auto mt-7 block min-h-11 rounded-full border border-white/15 px-6 text-sm text-content-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                                    >
                                        Ещё артисты
                                    </button>
                                )}
                            </>
                        ) : (
                            <div
                                id="taste-artist-results"
                                role="listbox"
                                aria-label="Найденные артисты"
                                className="mt-3 overflow-hidden rounded-2xl border border-white/10 bg-black/25"
                            >
                                {canonicalArtistSearch.isSearching ? (
                                    <div className="flex min-h-16 items-center gap-2 px-4 text-sm text-content-secondary">
                                        <LoaderCircle
                                            className="h-4 w-4 animate-spin motion-reduce:animate-none"
                                            aria-hidden="true"
                                        />
                                        Ищем артистов…
                                    </div>
                                ) : canonicalArtistSearch.error ? (
                                    <p className="px-4 py-3 text-sm text-red-200">
                                        Не удалось найти артистов. Проверьте
                                        подключение и попробуйте ещё раз.
                                    </p>
                                ) : canonicalArtistSearch.results.length ===
                                  0 ? (
                                    <p className="px-4 py-3 text-sm text-content-secondary">
                                        Артисты не найдены. Уточните имя.
                                    </p>
                                ) : (
                                    canonicalArtistSearch.results.map(
                                        (artist) => (
                                            <button
                                                key={artist.mbid}
                                                id={artistOptionId(artist.mbid)}
                                                type="button"
                                                role="option"
                                                data-artist-mbid={artist.mbid}
                                                aria-selected={isTasteLabelSelected(
                                                    selection.artists,
                                                    artist.name,
                                                )}
                                                disabled={isSaving}
                                                onClick={() =>
                                                    selectCanonicalArtist(
                                                        artist,
                                                    )
                                                }
                                                onMouseEnter={() =>
                                                    setActiveArtistIndex(
                                                        canonicalArtistSearch.results.indexOf(
                                                            artist,
                                                        ),
                                                    )
                                                }
                                                className={cn(
                                                    "flex min-h-14 w-full items-center justify-between gap-3 border-b border-white/8 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-light disabled:opacity-55 motion-reduce:transition-none",
                                                    activeArtist?.mbid ===
                                                        artist.mbid &&
                                                        "bg-white/[0.06]",
                                                )}
                                            >
                                                <span className="min-w-0">
                                                    <span className="block truncate text-sm font-semibold text-content">
                                                        {artist.name}
                                                    </span>
                                                    {(artist.disambiguation ||
                                                        artist.country) && (
                                                        <span className="mt-0.5 block truncate text-xs text-content-muted">
                                                            {[
                                                                artist.disambiguation,
                                                                artist.country,
                                                            ]
                                                                .filter(Boolean)
                                                                .join(" · ")}
                                                        </span>
                                                    )}
                                                </span>
                                                {isTasteLabelSelected(
                                                    selection.artists,
                                                    artist.name,
                                                ) && (
                                                    <Check
                                                        className="h-4 w-4 shrink-0 text-brand-light"
                                                        aria-hidden="true"
                                                    />
                                                )}
                                            </button>
                                        ),
                                    )
                                )}
                            </div>
                        )}
                        {count > 0 && (
                            <section
                                className="mt-7 border-t border-white/10 pt-5"
                                aria-label="Выбранные предпочтения"
                            >
                                <h3 className="mb-3 text-sm font-semibold text-content-secondary">
                                    Выбрано · {count}
                                </h3>
                                <div className="flex flex-wrap gap-2">
                                    {(["genres", "artists"] as const).flatMap(
                                        (kind) =>
                                            selection[kind].map((label) => (
                                                <button
                                                    key={`${kind}:${label}`}
                                                    type="button"
                                                    aria-label={`Убрать ${kind === "genres" ? "жанр" : "артиста"}: ${label}`}
                                                    disabled={isSaving}
                                                    onClick={() =>
                                                        updateChoice(
                                                            kind,
                                                            label,
                                                        )
                                                    }
                                                    className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-full bg-brand/15 px-3 text-sm text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                                                >
                                                    <span className="truncate">
                                                        {label}
                                                    </span>
                                                    <X
                                                        className="h-4 w-4 shrink-0"
                                                        aria-hidden="true"
                                                    />
                                                </button>
                                            )),
                                    )}
                                </div>
                            </section>
                        )}
                        <p className="mt-6 text-xs leading-5 text-content-muted lg:hidden">
                            Ваш выбор помогает настроить рекомендации на
                            главной. Прослушивания и лайки уточняют их дальше.
                            Настройка не ставит лайки автоматически.
                        </p>
                    </div>
                </div>
                <footer
                    data-testid="taste-profile-footer"
                    className="shrink-0 border-t border-white/10 px-5 pb-[max(1rem,var(--safe-area-bottom))] pt-3 sm:px-7 lg:col-start-1 lg:row-start-2 lg:border-t-0 lg:pb-8"
                >
                    <p
                        aria-live="polite"
                        className="mb-3 text-xs leading-5 text-content-secondary"
                    >
                        {validation.message ??
                            (count
                                ? `Выбрано: ${count}`
                                : "Выберите тех, кого любите. Количество — на ваше усмотрение.")}
                    </p>
                    {visibleError && (
                        <p role="alert" className="mb-3 text-sm text-red-200">
                            {visibleError}
                        </p>
                    )}
                    <div
                        data-testid="taste-profile-actions"
                        className="flex flex-col gap-2"
                    >
                        <button
                            type="button"
                            aria-label="Сохранить вкусы"
                            disabled={isSaving || validation.code !== "valid"}
                            onClick={() => void save()}
                            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-brand px-6 text-sm font-bold text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {isSaving && (
                                <LoaderCircle
                                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                                    aria-hidden="true"
                                />
                            )}
                            {isSaving ? "Сохраняем…" : "Настроить под меня"}
                        </button>
                        {mode === "onboarding" && onSkip && (
                            <button
                                type="button"
                                aria-label="Пропустить настройку"
                                disabled={isSaving}
                                onClick={() => void skip()}
                                className="min-h-11 rounded-full text-sm text-content-secondary hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                            >
                                Пропустить
                            </button>
                        )}
                    </div>
                    <p className="mt-3 hidden text-xs leading-5 text-content-muted lg:block">
                        Можно выбрать сколько угодно исполнителей. Свой выбор вы
                        сможете изменить в любой момент.
                    </p>
                </footer>
            </div>
        </div>
    );
}
