"use client";

import {
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type FormEvent,
} from "react";
import {
    Check,
    ChevronLeft,
    ChevronRight,
    LoaderCircle,
    Music2,
    Plus,
    Search,
    Sparkles,
    X,
} from "lucide-react";
import { nextFocusIndex } from "@/components/ui/focusTrapMath";
import { cn } from "@/utils/cn";
import {
    addTasteLabel,
    isTasteLabelSelected,
    normalizeTasteProfileSelection,
    toggleTasteLabel,
    validateTasteProfileSelection,
} from "../model";
import { SUGGESTED_ARTISTS, SUGGESTED_GENRES } from "../suggestions";
import type { TasteProfileSelection } from "../types";

type TasteProfileDialogMode = "onboarding" | "edit";
type TasteProfileStep = "genres" | "artists";

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
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function selectionSummary(selection: TasteProfileSelection): string {
    const labels = [...selection.genres, ...selection.artists];
    if (labels.length === 0) return "Пока ничего не выбрано";
    const visible = labels.slice(0, 4).join(" · ");
    const hiddenCount = labels.length - 4;
    return hiddenCount > 0 ? `${visible} · ещё ${hiddenCount}` : visible;
}

function ChoiceButton({
    label,
    selected,
    disabled,
    onClick,
}: {
    label: string;
    selected: boolean;
    disabled: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "group inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-semibold transition-[transform,background-color,border-color,color] duration-200",
                "active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transition-none",
                selected
                    ? "border-brand/60 bg-brand/15 text-content"
                    : "border-white/10 bg-black/20 text-content-secondary hover:border-white/20 hover:bg-white/[0.06] hover:text-content",
            )}
        >
            <span
                className={cn(
                    "grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors motion-reduce:transition-none",
                    selected
                        ? "border-brand bg-brand text-black"
                        : "border-white/20 text-transparent group-hover:border-white/35",
                )}
                aria-hidden="true"
            >
                <Check className="h-3.5 w-3.5" />
            </span>
            <span>{label}</span>
        </button>
    );
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
    const [step, setStep] = useState<TasteProfileStep>("genres");
    const [selection, setSelection] = useState(() =>
        normalizeTasteProfileSelection(initialSelection),
    );
    const [artistSearch, setArtistSearch] = useState("");
    const [localError, setLocalError] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
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
    const filteredArtists = useMemo(() => {
        const query = artistSearch.trim().toLocaleLowerCase("ru-RU");
        if (!query) return [...SUGGESTED_ARTISTS];
        return SUGGESTED_ARTISTS.filter((artist) =>
            artist.toLocaleLowerCase("ru-RU").includes(query),
        );
    }, [artistSearch]);
    const canAddCustomArtist = useMemo(() => {
        const query = artistSearch.trim();
        if (!query) return false;
        return !SUGGESTED_ARTISTS.some(
            (artist) =>
                artist.toLocaleLowerCase("ru-RU") ===
                query.toLocaleLowerCase("ru-RU"),
        );
    }, [artistSearch]);

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
        setSelection(
            (current) => toggleTasteLabel(current, kind, label).selection,
        );
        setLocalError(null);
    };
    const addCustomArtist = () => {
        const result = addTasteLabel(selection, "artists", artistSearch);
        setSelection(result.selection);
        setLocalError(result.error);
        if (!result.error) setArtistSearch("");
    };
    const submitCustomArtist = (event: FormEvent) => {
        event.preventDefault();
        addCustomArtist();
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

    return (
        <div
            className="fixed inset-0 z-[10020] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-5"
            role="presentation"
            onMouseDown={(event) => {
                if (
                    event.target === event.currentTarget &&
                    mode === "edit" &&
                    !isSaving
                ) {
                    onClose();
                }
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                aria-busy={isSaving}
                tabIndex={-1}
                className="wave-material max-h-[92dvh] w-full overflow-y-auto rounded-t-[2rem] border border-white/10 bg-surface-raised/95 px-5 pb-[max(1.25rem,var(--safe-area-bottom))] pt-5 shadow-2xl shadow-black/70 backdrop-blur-2xl sm:max-w-3xl sm:rounded-[2rem] sm:p-7"
            >
                <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 sm:gap-4">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-brand/25 bg-brand/12 text-brand-light">
                        <Music2 className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                        <p className="text-[0.68rem] font-bold uppercase tracking-[0.18em] text-brand-light">
                            {mode === "onboarding"
                                ? "Первый запуск"
                                : "Ваш музыкальный профиль"}
                        </p>
                        <h2
                            id={titleId}
                            className="mt-1.5 text-2xl font-black tracking-[-0.035em] text-content sm:text-3xl"
                        >
                            {mode === "onboarding"
                                ? "Настроим музыку под вас"
                                : "Изменить музыкальные вкусы"}
                        </h2>
                        <p
                            id={descriptionId}
                            className="mt-2 max-w-xl text-sm leading-6 text-content-secondary"
                        >
                            Выберите от 3 до 16 жанров и артистов. Это помогает
                            составить первые рекомендации и не ставит лайки
                            автоматически.
                        </p>
                    </div>
                    {mode === "edit" ? (
                        <button
                            type="button"
                            disabled={isSaving}
                            onClick={onClose}
                            aria-label="Закрыть настройку вкусов"
                            className="grid min-h-11 min-w-11 place-items-center rounded-full border border-white/10 bg-black/25 text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-50 motion-reduce:transition-none"
                        >
                            <X className="h-5 w-5" aria-hidden="true" />
                        </button>
                    ) : (
                        <span aria-hidden="true" className="h-11 w-1" />
                    )}
                </header>

                <div className="mt-6 grid grid-cols-2 gap-2" aria-hidden="true">
                    <span
                        className={cn(
                            "h-1.5 rounded-full",
                            step === "genres" ? "bg-brand" : "bg-brand/40",
                        )}
                    />
                    <span
                        className={cn(
                            "h-1.5 rounded-full",
                            step === "artists" ? "bg-brand" : "bg-white/10",
                        )}
                    />
                </div>

                <section className="mt-5">
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-content-muted">
                        Шаг {step === "genres" ? "1" : "2"} из 2
                    </p>
                    <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
                        <div>
                            <h3 className="text-xl font-bold tracking-[-0.025em] text-content">
                                {step === "genres"
                                    ? "Какая музыка вам близка?"
                                    : "Кого вы хотите слышать чаще?"}
                            </h3>
                            <p className="mt-1 text-sm leading-6 text-content-secondary">
                                {step === "genres"
                                    ? "Можно выбрать несколько направлений и уточнить их артистами на следующем шаге."
                                    : "Найдите артиста среди подсказок или добавьте имя вручную."}
                            </p>
                        </div>
                        <span
                            aria-live="polite"
                            className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs font-semibold text-content-secondary"
                        >
                            Выбрано {count} из 16
                        </span>
                    </div>

                    {step === "genres" ? (
                        <div className="mt-5 flex flex-wrap gap-2.5">
                            {SUGGESTED_GENRES.map((genre) => (
                                <ChoiceButton
                                    key={genre}
                                    label={genre}
                                    selected={isTasteLabelSelected(
                                        selection.genres,
                                        genre,
                                    )}
                                    disabled={
                                        isSaving ||
                                        (!isTasteLabelSelected(
                                            selection.genres,
                                            genre,
                                        ) &&
                                            (selection.genres.length >= 10 ||
                                                count >= 16))
                                    }
                                    onClick={() =>
                                        updateChoice("genres", genre)
                                    }
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="mt-5">
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
                                        setLocalError(null);
                                    }}
                                    aria-label="Найти или добавить артиста"
                                    placeholder="Например, Кино или Linkin Park"
                                    maxLength={80}
                                    autoComplete="off"
                                    className="min-h-12 w-full rounded-2xl border border-white/10 bg-black/25 py-3 pl-11 pr-4 text-sm text-content outline-none transition-colors placeholder:text-content-muted hover:border-white/20 focus:border-brand/60 focus:ring-2 focus:ring-brand/20 disabled:opacity-55 motion-reduce:transition-none"
                                />
                            </form>
                            <div className="mt-3 flex flex-wrap gap-2.5">
                                {filteredArtists.map((artist) => (
                                    <ChoiceButton
                                        key={artist}
                                        label={artist}
                                        selected={isTasteLabelSelected(
                                            selection.artists,
                                            artist,
                                        )}
                                        disabled={
                                            isSaving ||
                                            (!isTasteLabelSelected(
                                                selection.artists,
                                                artist,
                                            ) &&
                                                (selection.artists.length >=
                                                    10 ||
                                                    count >= 16))
                                        }
                                        onClick={() =>
                                            updateChoice("artists", artist)
                                        }
                                    />
                                ))}
                                {canAddCustomArtist && (
                                    <button
                                        type="button"
                                        disabled={isSaving}
                                        onClick={addCustomArtist}
                                        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-dashed border-brand/45 bg-brand/8 px-4 py-2.5 text-sm font-semibold text-brand-light transition-[transform,background-color,border-color] active:scale-[0.98] hover:border-brand/70 hover:bg-brand/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-55 motion-reduce:transition-none"
                                    >
                                        <Plus
                                            className="h-4 w-4"
                                            aria-hidden="true"
                                        />
                                        Добавить «{artistSearch.trim()}»
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </section>

                <div className="mt-6 flex items-start gap-3 rounded-2xl border border-brand/20 bg-brand/[0.07] px-4 py-3.5">
                    <Sparkles
                        className="mt-0.5 h-4 w-4 shrink-0 text-brand-light"
                        aria-hidden="true"
                    />
                    <div className="min-w-0">
                        <p className="text-xs font-bold uppercase tracking-[0.13em] text-brand-light">
                            Ваш старт
                        </p>
                        <p className="mt-1 break-words text-sm leading-5 text-content-secondary">
                            {selectionSummary(selection)}
                        </p>
                    </div>
                </div>

                {visibleError && (
                    <p
                        role="alert"
                        className="mt-4 rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm leading-5 text-red-200"
                    >
                        {visibleError}
                    </p>
                )}

                <footer className="mt-6 grid gap-3 border-t border-white/8 pt-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="text-sm leading-5 text-content-secondary">
                        {validation.code === "valid"
                            ? "Готово к сохранению. Изменить выбор можно позже в настройках."
                            : validation.message}
                    </div>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        {mode === "onboarding" && onSkip && (
                            <button
                                type="button"
                                disabled={isSaving}
                                onClick={() => void skip()}
                                className="inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-55 motion-reduce:transition-none"
                            >
                                Пропустить настройку
                            </button>
                        )}
                        {step === "artists" ? (
                            <button
                                type="button"
                                disabled={isSaving}
                                onClick={() => {
                                    setStep("genres");
                                    setLocalError(null);
                                }}
                                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-55 motion-reduce:transition-none"
                            >
                                <ChevronLeft
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                                Назад к жанрам
                            </button>
                        ) : mode === "edit" ? (
                            <button
                                type="button"
                                disabled={isSaving}
                                onClick={onClose}
                                className="inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-55 motion-reduce:transition-none"
                            >
                                Отмена
                            </button>
                        ) : null}

                        {step === "genres" ? (
                            <button
                                type="button"
                                disabled={isSaving}
                                onClick={() => {
                                    setStep("artists");
                                    setLocalError(null);
                                }}
                                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-black text-black transition-[transform,background-color] active:scale-[0.98] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised disabled:opacity-55 motion-reduce:transition-none"
                            >
                                Дальше: артисты
                                <ChevronRight
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                            </button>
                        ) : (
                            <button
                                type="button"
                                disabled={
                                    isSaving || validation.code !== "valid"
                                }
                                onClick={() => void save()}
                                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-black text-black transition-[transform,background-color] active:scale-[0.98] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none"
                            >
                                {isSaving && (
                                    <LoaderCircle
                                        className="h-4 w-4 animate-spin motion-reduce:animate-none"
                                        aria-hidden="true"
                                    />
                                )}
                                {isSaving ? "Сохраняем…" : "Сохранить вкусы"}
                            </button>
                        )}
                    </div>
                </footer>
            </div>
        </div>
    );
}
