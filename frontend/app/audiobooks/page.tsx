"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { AudiobookCard } from "@/components/ui/AudiobookCard";
import { api } from "@/lib/api";
import { useAudioState, useAudioControls } from "@/lib/audio-context";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { useAudiobooksQuery } from "@/hooks/useQueries";
import {
    createMigratingStorageKey,
    removeMigratingStorageItem,
} from "@/lib/storage-migration";
import { Book, ListTree, Shuffle } from "lucide-react";
import { pluralRu } from "@/lib/i18n/ru";
import { shuffleArray } from "@/utils/shuffle";
import { BRAND_NAME } from "@/lib/brand";
import { PageHeader } from "@/components/layout/PageHeader";

interface Audiobook {
    id: string;
    title: string;
    author: string;
    narrator?: string;
    description?: string;
    coverUrl: string | null;
    duration: number;
    libraryId: string;
    series?: {
        name: string;
        sequence: string;
    } | null;
    genres?: string[];
    source?: "federated";
    peer?: { id: string; name: string; online: boolean } | null;
    progress: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: Date;
    } | null;
}

interface AudiobookshelfConfigStatus {
    configured?: boolean;
}

type FilterType = "all" | "listening" | "finished";
type SortType = "title" | "author" | "recent" | "series";
const CURRENT_AUDIOBOOK_KEY = createMigratingStorageKey("current_audiobook");
const PLAYBACK_TYPE_KEY = createMigratingStorageKey("playback_type");

const isAudiobookshelfConfigStatus = (
    value: unknown,
): value is AudiobookshelfConfigStatus => {
    return typeof value === "object" && value !== null && "configured" in value;
};

/**
 * Renders the AudiobooksPage component.
 */
export default function AudiobooksPage() {
    const router = useRouter();
    useAuth();
    const { toast } = useToast();
    const { currentAudiobook } = useAudioState();
    const { pause } = useAudioControls();

    // Use React Query hook for audiobooks
    const { data: audiobooksData, isLoading, error } = useAudiobooksQuery();

    const [filter, setFilter] = useState<FilterType>("all");
    const [sortBy, setSortBy] = useState<SortType>("title");
    const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
    const [groupBySeries, setGroupBySeries] = useState(false);
    const [itemsPerPage, setItemsPerPage] = useState<number>(50);
    const [currentPage, setCurrentPage] = useState(1);

    // Check if Audiobookshelf is configured
    const isConfigured =
        !error &&
        (!audiobooksData ||
            !isAudiobookshelfConfigStatus(audiobooksData) ||
            audiobooksData.configured !== false);
    const audiobooks: Audiobook[] = useMemo(
        () => (Array.isArray(audiobooksData) ? audiobooksData : []),
        [audiobooksData],
    );

    // Clear player state if Audiobookshelf is disabled
    useEffect(() => {
        if (!isConfigured && currentAudiobook) {
            pause();
            // Clear from localStorage
            if (typeof window !== "undefined") {
                removeMigratingStorageItem(CURRENT_AUDIOBOOK_KEY);
                removeMigratingStorageItem(PLAYBACK_TYPE_KEY);
            }
        }
    }, [isConfigured, currentAudiobook, pause]);

    // Combine progress data with currently playing audiobook for real-time updates
    const continueListening = useMemo(() => {
        const inProgress = audiobooks.filter(
            (book) =>
                book.progress &&
                book.progress.progress > 0 &&
                !book.progress.isFinished,
        );

        // If currently playing an audiobook that's not in the list, prepend it
        if (
            currentAudiobook &&
            !inProgress.find((b) => b.id === currentAudiobook.id)
        ) {
            const currentBook = audiobooks.find(
                (b) => b.id === currentAudiobook.id,
            );
            if (currentBook) {
                return [currentBook, ...inProgress];
            }
        }
        return inProgress;
    }, [audiobooks, currentAudiobook]);

    // Get all unique genres
    const allGenres = Array.from(
        new Set(audiobooks.flatMap((book) => book.genres || [])),
    ).sort();

    const getFilteredAndSortedBooks = () => {
        // First filter by progress status
        let filtered = audiobooks;
        switch (filter) {
            case "listening":
                filtered = continueListening;
                break;
            case "finished":
                filtered = audiobooks.filter(
                    (book) => book.progress?.isFinished,
                );
                break;
        }

        // Filter by genre
        if (selectedGenre) {
            filtered = filtered.filter((book) =>
                book.genres?.includes(selectedGenre),
            );
        }

        // Sort
        const sorted = [...filtered];
        switch (sortBy) {
            case "title":
                sorted.sort((a, b) => a.title.localeCompare(b.title));
                break;
            case "author":
                sorted.sort((a, b) => a.author.localeCompare(b.author));
                break;
            case "recent":
                sorted.sort((a, b) => {
                    const aTime = a.progress?.lastPlayedAt
                        ? new Date(a.progress.lastPlayedAt).getTime()
                        : 0;
                    const bTime = b.progress?.lastPlayedAt
                        ? new Date(b.progress.lastPlayedAt).getTime()
                        : 0;
                    return bTime - aTime;
                });
                break;
            case "series":
                sorted.sort((a, b) => {
                    // Series books first, then one-offs
                    if (a.series && !b.series) return -1;
                    if (!a.series && b.series) return 1;
                    if (a.series && b.series) {
                        // Same series: sort by sequence
                        if (a.series.name === b.series.name) {
                            const aSeq = parseFloat(a.series.sequence || "0");
                            const bSeq = parseFloat(b.series.sequence || "0");
                            return aSeq - bSeq;
                        }
                        // Different series: sort by name
                        return a.series.name.localeCompare(b.series.name);
                    }
                    // Both one-offs: sort by title
                    return a.title.localeCompare(b.title);
                });
                break;
        }

        return sorted;
    };

    const filteredBooks = getFilteredAndSortedBooks();

    // Pagination
    const totalPages = Math.ceil(filteredBooks.length / itemsPerPage);
    const paginatedBooks = useMemo(() => {
        const start = (currentPage - 1) * itemsPerPage;
        return filteredBooks.slice(start, start + itemsPerPage);
    }, [filteredBooks, currentPage, itemsPerPage]);

    // Get series and standalone books for artist-style view
    const getSeriesAndStandalone = () => {
        const seriesMap = new Map<string, Audiobook[]>();
        const standalone: Audiobook[] = [];

        paginatedBooks.forEach((book) => {
            // Only treat as series if it has a series name
            if (
                book.series &&
                book.series.name &&
                book.series.name.trim() !== ""
            ) {
                const seriesName = book.series.name.trim();
                if (!seriesMap.has(seriesName)) {
                    seriesMap.set(seriesName, []);
                }
                seriesMap.get(seriesName)!.push(book);
            } else {
                standalone.push(book);
            }
        });

        // Sort each series by sequence to get first book for cover
        seriesMap.forEach((books) => {
            books.sort((a, b) => {
                const aSeq = parseFloat(a.series?.sequence || "0");
                const bSeq = parseFloat(b.series?.sequence || "0");
                return aSeq - bSeq;
            });
        });

        return { series: Array.from(seriesMap.entries()), standalone };
    };

    const { series, standalone } = getSeriesAndStandalone();

    const getCoverUrl = (coverUrl: string | null, size = 300) => {
        if (!coverUrl) return null;
        // Proxy through backend for caching
        return api.getCoverArtUrl(coverUrl, size);
    };

    // Shuffle all audiobooks
    const handleShuffleAudiobooks = () => {
        if (audiobooks.length === 0) {
            toast.error("Нет аудиокниг для случайного выбора");
            return;
        }
        // Shuffle the array
        const shuffled = shuffleArray(audiobooks);
        // Play the first one (audiobooks don't have a shuffle queue like tracks)
        if (shuffled[0]) {
            toast.success(`Случайная аудиокнига: ${shuffled[0].title}`);
            // Navigate to the audiobook
            router.push(`/audiobooks/${shuffled[0].id}`);
        }
    };

    if (isLoading) {
        return <LoadingScreen message="Загружаем аудиокниги…" />;
    }

    if (!isConfigured) {
        return (
            <div
                data-routed-surface="audiobooks"
                className="min-h-screen bg-surface"
            >
                <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                    <PageHeader
                        title="Аудиокниги"
                        subtitle="Подключите Audiobookshelf, чтобы открыть свою библиотеку аудиокниг"
                        icon={Book}
                    />

                    {/* Setup Steps - Horizontal Cards */}
                    <div className="mb-12 grid gap-6 md:grid-cols-3">
                        <div className="border-t border-line pt-5">
                            <div className="mb-4 text-4xl font-black text-brand/25">
                                01
                            </div>
                            <h3 className="mb-3 text-xl font-bold text-content">
                                Установите Audiobookshelf
                            </h3>
                            <p className="text-sm leading-relaxed text-content-muted">
                                Разверните Audiobookshelf через Docker или
                                используйте существующую установку
                            </p>
                        </div>

                        <div className="border-t border-line pt-5">
                            <div className="mb-4 text-4xl font-black text-brand/25">
                                02
                            </div>
                            <h3 className="mb-3 text-xl font-bold text-content">
                                Получите ключ API
                            </h3>
                            <p className="text-sm leading-relaxed text-content-muted">
                                Settings → Users → выберите пользователя → API
                                Tokens → Generate
                            </p>
                        </div>

                        <div className="border-t border-line pt-5">
                            <div className="mb-4 text-4xl font-black text-brand/25">
                                03
                            </div>
                            <h3 className="mb-3 text-xl font-bold text-content">
                                Подключите
                            </h3>
                            <p className="text-sm leading-relaxed text-content-muted">
                                Укажите адрес Audiobookshelf и ключ API в
                                настройках {BRAND_NAME}
                            </p>
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="mx-auto mb-12 flex max-w-2xl flex-col justify-center gap-4 sm:flex-row">
                        <Button
                            onClick={() =>
                                router.push(
                                    "/settings?tab=system#audiobookshelf",
                                )
                            }
                            className="min-h-12 flex-1 py-3 text-base font-semibold"
                        >
                            Настроить Audiobookshelf
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={() =>
                                window.open(
                                    "https://hub.docker.com/r/advplyr/audiobookshelf",
                                    "_blank",
                                )
                            }
                            className="min-h-12 flex-1 py-3 text-base font-semibold"
                        >
                            Установить через Docker
                        </Button>
                    </div>

                    {/* Footer Link */}
                    <div className="text-center">
                        <p className="mb-2 text-sm text-content-muted">
                            Нужна помощь?
                        </p>
                        <a
                            href="https://github.com/advplyr/audiobookshelf"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm text-content-muted transition-colors hover:bg-surface-elevated hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        >
                            Открыть документацию
                        </a>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            data-routed-surface="audiobooks"
            className="min-h-screen bg-surface"
        >
            <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                <PageHeader
                    title="Аудиокниги"
                    subtitle="Ваша библиотека Audiobookshelf"
                    icon={Book}
                    className="mb-0"
                />

                {/* Filter and Sort Controls - Mobile Optimized */}
                <div className="mb-10 space-y-3 border-y border-line py-5">
                    {/* First Row: Filter Pills and Shuffle */}
                    <div
                        role="group"
                        aria-label="Фильтр аудиокниг"
                        className="flex flex-wrap items-center gap-2"
                    >
                        <button
                            onClick={() => {
                                setFilter("all");
                                setCurrentPage(1);
                            }}
                            aria-pressed={filter === "all"}
                            className={`min-h-11 rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none ${
                                filter === "all"
                                    ? "bg-brand text-surface"
                                    : "border border-line bg-surface-elevated text-content-muted hover:bg-surface-hover hover:text-content"
                            }`}
                        >
                            Все книги
                        </button>
                        <button
                            onClick={() => {
                                setFilter("finished");
                                setCurrentPage(1);
                            }}
                            aria-pressed={filter === "finished"}
                            className={`min-h-11 rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none ${
                                filter === "finished"
                                    ? "bg-brand text-surface"
                                    : "border border-line bg-surface-elevated text-content-muted hover:bg-surface-hover hover:text-content"
                            }`}
                        >
                            Прослушанные
                        </button>

                        {/* Shuffle Button */}
                        <button
                            onClick={handleShuffleAudiobooks}
                            className="flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 py-2 font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            <Shuffle className="w-4 h-4" />
                            <span className="hidden sm:inline">
                                Случайная книга
                            </span>
                        </button>

                        {/* Results Count - Desktop only */}
                        <span className="ml-auto hidden text-sm text-content-muted md:inline">
                            {filteredBooks.length}{" "}
                            {pluralRu(filteredBooks.length, [
                                "книга",
                                "книги",
                                "книг",
                            ])}
                        </span>
                    </div>

                    {/* Second Row: Sort, Series View, Genre */}
                    <div className="flex flex-wrap items-center gap-2">
                        <select
                            value={sortBy}
                            onChange={(e) => {
                                setSortBy(e.target.value as SortType);
                                setCurrentPage(1);
                            }}
                            aria-label="Сортировка аудиокниг"
                            className="min-h-11 rounded-xl border border-line bg-surface-elevated px-4 py-2 text-sm text-content outline-none transition-colors focus:border-brand/60 focus:ring-2 focus:ring-brand/20 [&>option]:bg-surface-elevated [&>option]:text-content"
                        >
                            <option value="title">По названию</option>
                            <option value="author">По автору</option>
                            <option value="recent">Недавно слушали</option>
                            <option value="series">По серии</option>
                        </select>

                        <button
                            onClick={() => {
                                setGroupBySeries(!groupBySeries);
                                setCurrentPage(1);
                            }}
                            aria-pressed={groupBySeries}
                            className={`flex min-h-11 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none ${
                                groupBySeries
                                    ? "bg-brand text-surface"
                                    : "border border-line bg-surface-elevated text-content-muted hover:bg-surface-hover hover:text-content"
                            }`}
                            title="Объединять книги одной серии в карточку"
                        >
                            <ListTree className="w-4 h-4" />
                            <span className="hidden sm:inline">По сериям</span>
                        </button>

                        {allGenres.length > 0 && (
                            <select
                                value={selectedGenre || ""}
                                onChange={(e) => {
                                    setSelectedGenre(e.target.value || null);
                                    setCurrentPage(1);
                                }}
                                aria-label="Жанр аудиокниг"
                                className="min-h-11 min-w-0 flex-1 truncate rounded-xl border border-line bg-surface-elevated px-4 py-2 text-sm text-content outline-none transition-colors focus:border-brand/60 focus:ring-2 focus:ring-brand/20 md:min-w-[140px] md:flex-initial [&>option]:bg-surface-elevated [&>option]:text-content"
                            >
                                <option value="">Все жанры</option>
                                {allGenres.map((genre) => (
                                    <option key={genre} value={genre}>
                                        {genre}
                                    </option>
                                ))}
                            </select>
                        )}

                        {/* Items per page */}
                        <select
                            value={itemsPerPage}
                            onChange={(e) => {
                                setItemsPerPage(Number(e.target.value));
                                setCurrentPage(1);
                            }}
                            aria-label="Аудиокниг на странице"
                            className="min-h-11 rounded-xl border border-line bg-surface-elevated px-4 py-2 text-sm text-content outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/20 [&>option]:bg-surface-elevated [&>option]:text-content"
                        >
                            <option value={25}>25 на странице</option>
                            <option value={50}>50 на странице</option>
                            <option value={100}>100 на странице</option>
                            <option value={250}>250 на странице</option>
                        </select>
                    </div>

                    {/* Results Count - Mobile only */}
                    <div className="text-sm text-content-muted md:hidden">
                        {filteredBooks.length}{" "}
                        {pluralRu(filteredBooks.length, [
                            "книга",
                            "книги",
                            "книг",
                        ])}
                    </div>
                </div>

                <div className="space-y-8">
                    {/* Continue Listening Section */}
                    {continueListening.length > 0 &&
                        filter === "all" &&
                        !groupBySeries && (
                            <section>
                                <h2 className="mb-6 text-2xl font-black tracking-[-0.03em] text-content">
                                    Продолжить слушать
                                </h2>
                                <div
                                    className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8"
                                    data-tv-section="continue-listening"
                                >
                                    {continueListening.map((book, index) => (
                                        <AudiobookCard
                                            key={book.id}
                                            id={book.id}
                                            title={book.title}
                                            author={book.author}
                                            coverUrl={book.coverUrl}
                                            progress={book.progress}
                                            peer={book.peer ?? null}
                                            index={index}
                                            getCoverUrl={getCoverUrl}
                                        />
                                    ))}
                                </div>
                            </section>
                        )}

                    {/* Audiobooks Grid - Series View or Individual View */}
                    {filteredBooks.length > 0 ? (
                        groupBySeries ? (
                            // Series View - ONE card per series (like artist cards)
                            <>
                                {/* Series Cards */}
                                {series.length > 0 && (
                                    <section>
                                        <h2 className="mb-6 text-2xl font-black tracking-[-0.03em] text-content">
                                            Серии
                                        </h2>
                                        <div
                                            className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8"
                                            data-tv-section="series"
                                        >
                                            {series.map(
                                                (
                                                    [seriesName, books],
                                                    index,
                                                ) => {
                                                    const firstBook = books[0];
                                                    const bookCount = `${books.length} ${pluralRu(books.length, ["книга", "книги", "книг"])}`;
                                                    return (
                                                        <AudiobookCard
                                                            key={seriesName}
                                                            id={seriesName}
                                                            title={seriesName}
                                                            author={
                                                                firstBook.author
                                                            }
                                                            coverUrl={
                                                                firstBook.coverUrl
                                                            }
                                                            seriesBadge={
                                                                bookCount
                                                            }
                                                            index={index}
                                                            getCoverUrl={
                                                                getCoverUrl
                                                            }
                                                        />
                                                    );
                                                },
                                            )}
                                        </div>
                                    </section>
                                )}

                                {/* Standalone Books */}
                                {standalone.length > 0 && (
                                    <section>
                                        <h2 className="mb-6 text-2xl font-black tracking-[-0.03em] text-content">
                                            Отдельные книги
                                        </h2>
                                        <div
                                            className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8"
                                            data-tv-section="standalone"
                                        >
                                            {standalone.map((book, index) => (
                                                <AudiobookCard
                                                    key={book.id}
                                                    id={book.id}
                                                    title={book.title}
                                                    author={book.author}
                                                    coverUrl={book.coverUrl}
                                                    progress={book.progress}
                                                    peer={book.peer ?? null}
                                                    index={index}
                                                    getCoverUrl={getCoverUrl}
                                                />
                                            ))}
                                        </div>
                                    </section>
                                )}
                            </>
                        ) : (
                            // Ungrouped Grid - Uniform Cards
                            <div
                                className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8"
                                data-tv-section="audiobooks"
                            >
                                {paginatedBooks.map((book, index) => (
                                    <AudiobookCard
                                        key={book.id}
                                        id={book.id}
                                        title={book.title}
                                        author={book.author}
                                        coverUrl={book.coverUrl}
                                        progress={book.progress}
                                        peer={book.peer ?? null}
                                        index={index}
                                        getCoverUrl={getCoverUrl}
                                    />
                                ))}
                            </div>
                        )
                    ) : (
                        <section className="border-y border-line">
                            <EmptyState
                                icon={<Book className="w-12 h-12" />}
                                title={
                                    filter === "listening"
                                        ? "Нет начатых аудиокниг"
                                        : filter === "finished"
                                          ? "Нет прослушанных аудиокниг"
                                          : "Аудиокниги не найдены"
                                }
                                description={
                                    filter === "all"
                                        ? "Добавьте книги в библиотеку Audiobookshelf, чтобы начать"
                                        : "Начните слушать любую аудиокнигу"
                                }
                            />
                        </section>
                    )}

                    {/* Pagination Controls */}
                    {totalPages > 1 && (
                        <div className="mt-8 flex flex-wrap items-center justify-center gap-2 border-t border-line pt-8">
                            <button
                                onClick={() => setCurrentPage(1)}
                                disabled={currentPage === 1}
                                className="min-h-11 rounded-xl px-3 py-2 text-sm text-content-muted transition-colors hover:bg-surface-elevated hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Первая
                            </button>
                            <button
                                onClick={() =>
                                    setCurrentPage((p) => Math.max(1, p - 1))
                                }
                                disabled={currentPage === 1}
                                className="min-h-11 rounded-xl px-3 py-2 text-sm text-content-muted transition-colors hover:bg-surface-elevated hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Назад
                            </button>
                            <span className="px-2 py-2 text-sm text-content sm:px-4">
                                Страница {currentPage} из {totalPages}
                            </span>
                            <button
                                onClick={() =>
                                    setCurrentPage((p) =>
                                        Math.min(totalPages, p + 1),
                                    )
                                }
                                disabled={currentPage === totalPages}
                                className="min-h-11 rounded-xl px-3 py-2 text-sm text-content-muted transition-colors hover:bg-surface-elevated hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Далее
                            </button>
                            <button
                                onClick={() => setCurrentPage(totalPages)}
                                disabled={currentPage === totalPages}
                                className="min-h-11 rounded-xl px-3 py-2 text-sm text-content-muted transition-colors hover:bg-surface-elevated hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Последняя
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
