"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
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

    // Reset to page 1 when filters change.
    useEffect(() => {
        setCurrentPage(1);
    }, [filter, sortBy, selectedGenre, groupBySeries]);

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
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!isConfigured) {
        return (
            <div className="min-h-screen relative overflow-hidden">
                {/* Background gradient */}
                <div className="absolute inset-0 pointer-events-none">
                    <div
                        className="absolute inset-0 bg-gradient-to-b from-brand/15 via-blue-900/10 to-transparent"
                        style={{ height: "35vh" }}
                    />
                    <div
                        className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-brand/8 via-transparent to-transparent"
                        style={{ height: "25vh" }}
                    />
                </div>

                <div className="relative px-4 md:px-8 py-16 md:py-24">
                    {/* Title Section */}
                    <div className="text-center mb-16">
                        <h1 className="text-3xl md:text-4xl font-bold text-white mb-6 tracking-tight">
                            Аудиокниги
                        </h1>
                        <p className="text-xl md:text-2xl text-gray-400 max-w-2xl mx-auto">
                            Подключите Audiobookshelf, чтобы открыть свою
                            библиотеку аудиокниг
                        </p>
                    </div>

                    {/* Setup Steps - Horizontal Cards */}
                    <div className="grid md:grid-cols-3 gap-6 mb-12">
                        <div className="bg-gradient-to-br from-surface-sunken to-surface rounded-xl p-6 border border-white/5 hover:border-white/10 transition-all">
                            <div className="text-4xl font-black text-blue-400/20 mb-4">
                                01
                            </div>
                            <h3 className="text-xl font-bold text-white mb-3">
                                Установите Audiobookshelf
                            </h3>
                            <p className="text-gray-400 text-sm leading-relaxed">
                                Разверните Audiobookshelf через Docker или
                                используйте существующую установку
                            </p>
                        </div>

                        <div className="bg-gradient-to-br from-surface-sunken to-surface rounded-xl p-6 border border-white/5 hover:border-white/10 transition-all">
                            <div className="text-4xl font-black text-blue-400/20 mb-4">
                                02
                            </div>
                            <h3 className="text-xl font-bold text-white mb-3">
                                Получите ключ API
                            </h3>
                            <p className="text-gray-400 text-sm leading-relaxed">
                                Settings → Users → выберите пользователя → API
                                Tokens → Generate
                            </p>
                        </div>

                        <div className="bg-gradient-to-br from-surface-sunken to-surface rounded-xl p-6 border border-white/5 hover:border-white/10 transition-all">
                            <div className="text-4xl font-black text-blue-400/20 mb-4">
                                03
                            </div>
                            <h3 className="text-xl font-bold text-white mb-3">
                                Подключите
                            </h3>
                            <p className="text-gray-400 text-sm leading-relaxed">
                                Укажите адрес Audiobookshelf и ключ API в
                                настройках {BRAND_NAME}
                            </p>
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-col sm:flex-row gap-4 justify-center max-w-2xl mx-auto mb-12">
                        <Button
                            onClick={() =>
                                router.push(
                                    "/settings?tab=system#audiobookshelf",
                                )
                            }
                            className="flex-1 py-6 text-lg font-semibold"
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
                            className="flex-1 py-6 text-lg font-semibold"
                        >
                            Установить через Docker
                        </Button>
                    </div>

                    {/* Footer Link */}
                    <div className="text-center">
                        <p className="text-gray-400 text-sm mb-2">
                            Нужна помощь?
                        </p>
                        <a
                            href="https://github.com/advplyr/audiobookshelf"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-400 hover:text-white text-sm transition-colors"
                        >
                            Открыть документацию
                        </a>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen relative">
            {/* Background gradient */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-gradient-to-b from-brand/15 via-blue-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-brand/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            {/* Hero Section */}
            <div className="relative">
                <div className="px-4 md:px-8 py-6">
                    <PageHeader
                        title="Аудиокниги"
                        subtitle="Ваша библиотека Audiobookshelf"
                        icon={Book}
                        className="mb-0"
                    />
                </div>
            </div>

            <div className="relative px-4 md:px-8 pb-24">
                {/* Filter and Sort Controls - Mobile Optimized */}
                <div className="mb-8 space-y-3">
                    {/* First Row: Filter Pills and Shuffle */}
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            onClick={() => setFilter("all")}
                            className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
                                filter === "all"
                                    ? "bg-white text-black"
                                    : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white border border-white/10"
                            }`}
                        >
                            Все книги
                        </button>
                        <button
                            onClick={() => setFilter("finished")}
                            className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
                                filter === "finished"
                                    ? "bg-white text-black"
                                    : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white border border-white/10"
                            }`}
                        >
                            Прослушанные
                        </button>

                        {/* Shuffle Button */}
                        <button
                            onClick={handleShuffleAudiobooks}
                            className="flex items-center gap-2 px-4 py-2 bg-brand-hover hover:bg-brand text-black font-medium rounded-full transition-all hover:scale-105"
                        >
                            <Shuffle className="w-4 h-4" />
                            <span className="hidden sm:inline">
                                Случайная книга
                            </span>
                        </button>

                        {/* Results Count - Desktop only */}
                        <span className="hidden md:inline text-sm text-gray-400 ml-auto">
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
                            onChange={(e) =>
                                setSortBy(e.target.value as SortType)
                            }
                            className="px-4 py-2 bg-surface-hover border border-white/10 rounded-full text-white text-sm focus:outline-none focus:border-blue-500 focus:bg-[#252525] transition-all [&>option]:bg-surface-hover [&>option]:text-white"
                        >
                            <option value="title">По названию</option>
                            <option value="author">По автору</option>
                            <option value="recent">Недавно слушали</option>
                            <option value="series">По серии</option>
                        </select>

                        <button
                            onClick={() => setGroupBySeries(!groupBySeries)}
                            className={`px-4 py-2 rounded-full text-sm font-semibold transition-all flex items-center gap-2 ${
                                groupBySeries
                                    ? "bg-white text-black"
                                    : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white border border-white/10"
                            }`}
                            title="Объединять книги одной серии в карточку"
                        >
                            <ListTree className="w-4 h-4" />
                            <span className="hidden sm:inline">По сериям</span>
                        </button>

                        {allGenres.length > 0 && (
                            <select
                                value={selectedGenre || ""}
                                onChange={(e) =>
                                    setSelectedGenre(e.target.value || null)
                                }
                                className="flex-1 min-w-0 md:flex-initial md:min-w-[140px] px-4 py-2 bg-surface-hover border border-white/10 rounded-full text-white text-sm focus:outline-none focus:border-blue-500 focus:bg-[#252525] transition-all truncate [&>option]:bg-surface-hover [&>option]:text-white"
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
                            className="px-4 py-2 bg-surface-hover border border-white/10 rounded-full text-white text-sm focus:outline-none focus:border-blue-500 [&>option]:bg-surface-hover [&>option]:text-white"
                        >
                            <option value={25}>25 на странице</option>
                            <option value={50}>50 на странице</option>
                            <option value={100}>100 на странице</option>
                            <option value={250}>250 на странице</option>
                        </select>
                    </div>

                    {/* Results Count - Mobile only */}
                    <div className="md:hidden text-sm text-gray-400">
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
                                <h2 className="text-xl font-bold text-white mb-6">
                                    Продолжить слушать
                                </h2>
                                <div
                                    className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-6"
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
                                        <h2 className="text-xl font-bold text-white mb-6">
                                            Серии
                                        </h2>
                                        <div
                                            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-6"
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
                                        <h2 className="text-xl font-bold text-white mb-6">
                                            Отдельные книги
                                        </h2>
                                        <div
                                            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-6"
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
                                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-6"
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
                    )}

                    {/* Pagination Controls */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 mt-8 pt-8 border-t border-white/10">
                            <button
                                onClick={() => setCurrentPage(1)}
                                disabled={currentPage === 1}
                                className="px-3 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Первая
                            </button>
                            <button
                                onClick={() =>
                                    setCurrentPage((p) => Math.max(1, p - 1))
                                }
                                disabled={currentPage === 1}
                                className="px-3 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Назад
                            </button>
                            <span className="px-4 py-2 text-sm text-white">
                                Страница {currentPage} из {totalPages}
                            </span>
                            <button
                                onClick={() =>
                                    setCurrentPage((p) =>
                                        Math.min(totalPages, p + 1),
                                    )
                                }
                                disabled={currentPage === totalPages}
                                className="px-3 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Далее
                            </button>
                            <button
                                onClick={() => setCurrentPage(totalPages)}
                                disabled={currentPage === totalPages}
                                className="px-3 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
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
