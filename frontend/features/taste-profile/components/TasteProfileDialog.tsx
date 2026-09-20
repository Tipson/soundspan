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
import { useTasteArtistCatalog } from "../hooks/useTasteArtistCatalog";
import { useTasteArtistArtwork } from "../hooks/useTasteArtistArtwork";
import { cn } from "@/utils/cn";
import {
    addTasteLabel,
    isTasteLabelSelected,
    normalizeTasteProfileSelection,
    toggleTasteLabel,
    validateTasteProfileSelection,
} from "../model";
import { TasteGenrePicker } from "./TasteGenrePicker";
import { suggestArtistsForGenres } from "../suggestions";
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
    const moreRef = useRef<HTMLButtonElement>(null);
    const [activeArtistIndex, setActiveArtistIndex] = useState(-1);
    const [localError, setLocalError] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    const savingRef = useRef(isSaving);
    const submissionRef = useRef<"save" | "skip" | null>(null);
    const titleId = useId();
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
    const catalog = useTasteArtistCatalog(
        artistGenre === "selected"
            ? selection.genres
            : artistGenre === "all"
              ? []
              : [artistGenre],
        !canonicalArtistSearch.hasQuery,
    );
    const visibleArtists = catalog.artists ?? suggestedArtists.slice(0, 24);
    const { hasNextPage, isFetching, isError, fetchNextPage } = catalog;
    useEffect(() => {
        if (
            !hasNextPage ||
            isFetching ||
            isError ||
            canonicalArtistSearch.hasQuery ||
            isSaving ||
            typeof IntersectionObserver === "undefined"
        )
            return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting))
                    void fetchNextPage();
            },
            { root: resultsRef.current, rootMargin: "200px" },
        );
        if (moreRef.current) observer.observe(moreRef.current);
        return () => observer.disconnect();
    }, [
        hasNextPage,
        isFetching,
        isError,
        fetchNextPage,
        canonicalArtistSearch.hasQuery,
        isSaving,
    ]);
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
        setArtistSearch("");
        if (resultsRef.current) resultsRef.current.scrollTop = 0;
    };

    return (
        <div
            className="fixed inset-0 z-[10020] bg-surface-raised"
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
                aria-busy={isSaving}
                tabIndex={-1}
                className="relative grid h-[100dvh] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)] bg-surface-raised text-content focus:outline-none"
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
                <header className="shrink-0 px-5 pb-5 pr-20 pt-[max(1.5rem,var(--safe-area-top))] sm:px-10 sm:pr-20 sm:pt-8 lg:col-start-1 lg:row-start-1 lg:px-8 lg:pb-6 lg:pt-10">
                    <h2
                        id={titleId}
                        className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl"
                    >
                        Любимые исполнители
                    </h2>
                </header>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:pt-10">
                    <div
                        data-testid="taste-profile-controls"
                        className="relative z-10 shrink-0 space-y-4 bg-surface-raised px-5 pb-5 sm:px-10 lg:pl-4 lg:pr-20"
                    >
                        <TasteGenrePicker
                            value={artistGenre}
                            hasSavedGenres={selection.genres.length > 0}
                            disabled={isSaving}
                            onChange={changeGenre}
                        />
                        <form
                            onSubmit={submitCustomArtist}
                            className="relative max-w-xl"
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
                        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8 pt-2 sm:px-10 lg:pl-4"
                    >
                        {!canonicalArtistSearch.hasQuery ? (
                            <>
                                <div
                                    className="grid grid-cols-3 gap-x-4 gap-y-7 pt-2 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] sm:gap-x-8 sm:gap-y-10"
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
                                                        "relative mx-auto block aspect-square w-full max-w-40 rounded-full border-[3px] p-1 transition-[border-color,transform] group-hover:scale-[1.025] motion-reduce:transform-none motion-reduce:transition-none",
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
                                {catalog.isFetching && (
                                    <p
                                        role="status"
                                        className="mt-5 text-center text-sm text-content-secondary"
                                    >
                                        Загружаем исполнителей…
                                    </p>
                                )}
                                {catalog.isError && (
                                    <p
                                        role="status"
                                        className="mt-5 text-center text-sm text-content-secondary"
                                    >
                                        {catalog.artists
                                            ? "Не удалось загрузить продолжение."
                                            : "Каталог временно недоступен."}
                                    </p>
                                )}
                                {(catalog.hasNextPage || catalog.isError) && (
                                    <button
                                        ref={moreRef}
                                        type="button"
                                        disabled={
                                            isSaving || catalog.isFetching
                                        }
                                        onClick={() =>
                                            void (catalog.artists
                                                ? catalog.fetchNextPage()
                                                : catalog.refetch())
                                        }
                                        className="mx-auto mt-7 block min-h-11 rounded-full border border-white/15 px-6 text-sm text-content-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                                    >
                                        {catalog.isError
                                            ? "Повторить загрузку"
                                            : "Ещё артисты"}
                                    </button>
                                )}
                                {catalog.artists &&
                                    !catalog.hasNextPage &&
                                    !catalog.isFetching &&
                                    !catalog.isError && (
                                        <p className="mt-5 text-center text-xs text-content-muted">
                                            Больше исполнителей не найдено.
                                        </p>
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
                    </div>
                </div>
                <footer
                    data-testid="taste-profile-footer"
                    className="shrink-0 border-t border-white/5 bg-surface-raised px-5 pb-[max(1rem,var(--safe-area-bottom))] pt-4 sm:px-10 lg:col-start-1 lg:row-start-2 lg:self-start lg:border-0 lg:px-8 lg:pt-0"
                >
                    {validation.message && (
                        <p role="alert" className="mb-3 text-sm text-red-200">
                            {validation.message}
                        </p>
                    )}
                    {visibleError && (
                        <p role="alert" className="mb-3 text-sm text-red-200">
                            {visibleError}
                        </p>
                    )}
                    <div
                        data-testid="taste-profile-actions"
                        className="flex flex-wrap items-center justify-end gap-3 lg:flex-col lg:items-stretch"
                    >
                        {count > 0 && (
                            <span
                                aria-live="polite"
                                className="mr-auto text-sm text-content-secondary"
                            >
                                Выбрано: {count}
                            </span>
                        )}
                        <button
                            type="button"
                            aria-label="Сохранить вкусы"
                            disabled={isSaving || validation.code !== "valid"}
                            onClick={() => void save()}
                            className="relative isolate inline-flex min-h-14 min-w-40 flex-1 items-center justify-center gap-2 overflow-hidden rounded-full border border-brand/30 bg-brand/15 px-5 text-sm font-bold text-content transition-[background-color,transform] hover:bg-brand/25 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none motion-reduce:transform-none lg:w-full lg:flex-none"
                        >
                            <span
                                aria-hidden="true"
                                data-testid="taste-action-fill"
                                className="pointer-events-none absolute inset-0 -z-10 origin-left rounded-full bg-gradient-to-r from-brand/55 to-brand/35 transition-transform duration-500 ease-out motion-reduce:transition-none"
                                style={{
                                    transform: `scaleX(${count === 0 ? 0 : 0.25 + 0.75 * (1 - Math.exp(-count / 4))})`,
                                }}
                            />
                            {isSaving && (
                                <LoaderCircle
                                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                                    aria-hidden="true"
                                />
                            )}
                            {isSaving
                                ? "Сохраняем…"
                                : count === 0
                                  ? "Готово"
                                  : count === 1
                                    ? "Настроить по выбору"
                                    : "Настроить под меня"}
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
                </footer>
            </div>
        </div>
    );
}
