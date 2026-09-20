"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    SlidersHorizontal,
    X,
} from "lucide-react";
import { GENRE_GROUPS } from "../suggestions";
import { cn } from "@/utils/cn";

const QUICK_GENRES = [
    ...new Set([
        "Поп",
        "Русская поп-музыка",
        "Русский рэп",
        "Рок",
        "Русский рок",
        "Хип-хоп",
        "Электроника",
        "Инди",
        "R&B",
        "Метал",
        "Танцевальная",
        ...GENRE_GROUPS.flatMap((group) => [...group.genres]),
    ]),
];

/** Compact genre shortcuts with an expandable, keyboard-accessible genre palette. */
export function TasteGenrePicker({
    value,
    hasSavedGenres,
    disabled,
    onChange,
}: {
    value: string;
    hasSavedGenres: boolean;
    disabled: boolean;
    onChange: (genre: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const id = useId();
    const row = useRef<HTMLDivElement>(null);
    const track = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ previous: false, next: false });
    const genres = [
        "all",
        ...QUICK_GENRES,
        ...(hasSavedGenres ? ["selected"] : []),
    ];
    const label = (genre: string) =>
        genre === "all"
            ? "Все исполнители"
            : genre === "selected"
              ? "Мои жанры"
              : genre;
    useLayoutEffect(() => {
        const element = row.current;
        if (!element) return;
        const measure = () =>
            setEdges({
                previous: element.scrollLeft > 1,
                next:
                    element.scrollLeft + element.clientWidth <
                    element.scrollWidth - 1,
            });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        if (track.current) observer.observe(track.current);
        element.addEventListener("scroll", measure, { passive: true });
        return () => {
            observer.disconnect();
            element.removeEventListener("scroll", measure);
        };
    }, [hasSavedGenres]);
    const scroll = (direction: number) => {
        row.current?.scrollBy({
            left: direction * row.current.clientWidth * 0.8,
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches
                ? "auto"
                : "smooth",
        });
    };
    useLayoutEffect(() => {
        const element = row.current;
        const selected = element?.querySelector<HTMLButtonElement>(
            '[aria-pressed="true"]',
        );
        if (!element || !selected || !element.clientWidth) return;
        const bounds = element.getBoundingClientRect();
        const button = selected.getBoundingClientRect();
        if (button.left < bounds.left)
            element.scrollLeft += button.left - bounds.left;
        else if (button.right > bounds.right)
            element.scrollLeft += button.right - bounds.right;
    }, [value]);
    const close = () => {
        setOpen(false);
        trigger.current?.focus();
    };
    const choose = (genre: string) => {
        onChange(genre);
        if (open) close();
    };
    const chip = (genre: string, label = genre) => (
        <button
            key={genre}
            type="button"
            disabled={disabled}
            aria-pressed={value === genre}
            onClick={() => choose(genre)}
            className={cn(
                "min-h-11 shrink-0 whitespace-nowrap rounded-full px-4 text-sm font-medium transition-[background-color,transform] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none motion-reduce:transform-none",
                value === genre
                    ? "bg-brand/20 text-brand-light"
                    : "bg-white/5 text-content-secondary hover:bg-white/10",
            )}
        >
            {label}
        </button>
    );
    return (
        <div
            className="relative min-w-0 text-base font-medium"
            role="group"
            aria-label="Фильтр по жанру"
            onKeyDown={(event) => {
                if (event.key === "Escape" && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                }
            }}
        >
            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
                <div
                    ref={row}
                    aria-label="Жанры"
                    className="min-w-0 basis-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] sm:flex-1 sm:basis-0 [&::-webkit-scrollbar]:hidden"
                >
                    <div ref={track} className="flex w-max gap-2 p-1">
                        {genres.map((genre) => chip(genre, label(genre)))}
                    </div>
                </div>
                <div className="flex shrink-0 gap-1">
                    <button
                        type="button"
                        aria-label="Предыдущие жанры"
                        disabled={disabled || !edges.previous}
                        onClick={() => scroll(-1)}
                        className="grid h-11 w-11 place-items-center rounded-full border border-white/15 text-content hover:bg-white/10 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                    >
                        <ChevronLeft aria-hidden="true" className="h-5 w-5" />
                    </button>
                    <button
                        type="button"
                        aria-label="Следующие жанры"
                        disabled={disabled || !edges.next}
                        onClick={() => scroll(1)}
                        className="grid h-11 w-11 place-items-center rounded-full border border-white/15 text-content hover:bg-white/10 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                    >
                        <ChevronRight aria-hidden="true" className="h-5 w-5" />
                    </button>
                </div>
                <button
                    ref={trigger}
                    type="button"
                    disabled={disabled}
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={() => setOpen(!open)}
                    className="ml-auto flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-4 text-sm font-medium text-content hover:bg-brand/20 transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none"
                >
                    <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
                    Все жанры
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(
                            "h-4 w-4 transition-transform motion-reduce:transition-none",
                            open && "rotate-180",
                        )}
                    />
                </button>
            </div>
            {open && (
                <section
                    id={id}
                    aria-label="Все жанры"
                    className="absolute inset-x-0 top-full z-20 mt-3 max-h-[min(55dvh,32rem)] overflow-y-auto overscroll-contain rounded-3xl border border-white/10 bg-surface-raised p-5 shadow-2xl sm:p-6"
                >
                    <div className="mb-5 flex items-center justify-between gap-3">
                        <h3 className="text-lg font-semibold">Жанры</h3>
                        <button
                            type="button"
                            aria-label="Закрыть жанры"
                            onClick={close}
                            className="grid h-11 w-11 place-items-center rounded-full bg-white/5 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        >
                            <X aria-hidden="true" className="h-5 w-5" />
                        </button>
                    </div>
                    <div className="mb-6 flex flex-wrap gap-2">
                        {chip("all", "Все исполнители")}
                        {hasSavedGenres &&
                            chip("selected", "По сохранённым жанрам")}
                    </div>
                    <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
                        {GENRE_GROUPS.map((group) => (
                            <div key={group.label}>
                                <h4 className="mb-3 text-xs font-semibold text-content-muted">
                                    {group.label}
                                </h4>
                                <div className="flex flex-wrap gap-2">
                                    {group.genres.map((genre) => chip(genre))}
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
