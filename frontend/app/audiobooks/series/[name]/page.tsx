"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { api } from "@/lib/api";
import { formatDuration } from "@/utils/formatTime";
import { useAuth } from "@/lib/auth-context";
import {
    useAudioState,
    usePlaybackStatus,
    useAudioControls,
} from "@/lib/audio-context";
import { useToast } from "@/lib/toast-context";
import { ArrowLeft, Book, Clock, Play, Pause, CheckCircle } from "lucide-react";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface Audiobook {
    id: string;
    title: string;
    author: string;
    narrator?: string;
    description?: string;
    coverUrl: string | null;
    duration: number;
    series?: {
        name: string;
        sequence: string;
    } | null;
    genres?: string[];
    progress: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: Date;
    } | null;
}

/**
 * Renders the SeriesDetailPage component.
 */
export default function SeriesDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { toast } = useToast();
    const { currentAudiobook, playbackType } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    const { playAudiobook, pause, resume } = useAudioControls();

    const seriesName = decodeURIComponent(params.name as string);
    const [books, setBooks] = useState<Audiobook[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (!isAuthenticated) return;

        const loadSeries = async () => {
            setIsLoading(true);
            try {
                const data = await api.getAudiobookSeries(seriesName);
                setBooks(Array.isArray(data) ? data : []);
            } catch (error: unknown) {
                sharedFrontendLogger.error("Failed to load series:", error);
                toast.error("Не удалось загрузить цикл книг");
            } finally {
                setIsLoading(false);
            }
        };

        loadSeries();
    }, [seriesName, isAuthenticated, toast]);

    const getCoverUrl = (coverUrl: string | null, size = 300) => {
        if (!coverUrl) return null;
        return api.getCoverArtUrl(coverUrl, size);
    };

    if (isLoading) {
        return <LoadingScreen message="Загружаем цикл аудиокниг…" />;
    }

    if (books.length === 0) {
        return (
            <div
                data-routed-surface="audiobook-series"
                className="min-h-screen bg-surface px-4 py-8"
            >
                <EmptyState
                    icon={<Book />}
                    title="В этом цикле нет книг"
                    description="Вернитесь в каталог и выберите другой цикл."
                    action={{
                        label: "К аудиокнигам",
                        onClick: () => router.push("/audiobooks"),
                    }}
                />
            </div>
        );
    }

    const firstBook = books[0];
    const author = firstBook.author;
    const genres = firstBook.genres || [];
    const totalDuration = books.reduce((sum, book) => sum + book.duration, 0);

    return (
        <div
            data-routed-surface="audiobook-series"
            className="min-h-screen bg-surface"
        >
            <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                <PageHeader
                    title={seriesName}
                    subtitle={`${author} · ${books.length} ${
                        books.length === 1
                            ? "книга"
                            : books.length >= 2 && books.length <= 4
                              ? "книги"
                              : "книг"
                    } · ${formatDuration(totalDuration)}`}
                    icon={Book}
                    actions={
                        <Button
                            variant="ghost"
                            onClick={() => router.back()}
                            className="min-h-11"
                        >
                            <ArrowLeft className="mr-2 h-4 w-4" />
                            Назад
                        </Button>
                    }
                />

                <section className="mb-10 flex flex-col gap-6 border-y border-line py-6 sm:flex-row sm:items-center">
                    <div className="relative aspect-square w-40 flex-shrink-0 overflow-hidden rounded-xl bg-surface-elevated shadow-2xl shadow-black/20 sm:w-52">
                        {firstBook.coverUrl &&
                        getCoverUrl(firstBook.coverUrl, 500) ? (
                            <Image
                                src={getCoverUrl(firstBook.coverUrl, 500)!}
                                alt={seriesName}
                                fill
                                sizes="(max-width: 640px) 160px, 208px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center">
                                <Book className="h-20 w-20 text-content-muted" />
                            </div>
                        )}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-content-muted">
                            Цикл аудиокниг
                        </p>
                        {genres.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {genres.slice(0, 5).map((genre) => (
                                    <Badge key={genre} variant="default">
                                        {genre}
                                    </Badge>
                                ))}
                            </div>
                        )}
                    </div>
                </section>

                <h2 className="mb-6 text-2xl font-black tracking-[-0.03em] text-content">
                    Книги цикла
                </h2>

                <div className="divide-y divide-line border-y border-line">
                    {books.map((book, index) => {
                        const isCurrentBook =
                            currentAudiobook?.id === book.id &&
                            playbackType === "audiobook";
                        const isBookPlaying = isCurrentBook && isPlaying;

                        return (
                            <div
                                key={book.id}
                                className="group px-1 py-4 transition-colors hover:bg-surface-elevated/60 motion-reduce:transition-none sm:px-3"
                            >
                                <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                                    {/* Book Number */}
                                    <div className="w-8 text-center">
                                        {isBookPlaying ? (
                                            <div className="flex items-center justify-center">
                                                <div className="w-4 h-4 flex items-center justify-center">
                                                    <div className="grid grid-cols-2 gap-0.5">
                                                        <div className="h-3 w-1 animate-pulse bg-brand motion-reduce:animate-none" />
                                                        <div className="h-3 w-1 animate-pulse bg-brand delay-75 motion-reduce:animate-none" />
                                                    </div>
                                                </div>
                                            </div>
                                        ) : (
                                            <span className="font-medium text-content-muted">
                                                {book.series?.sequence ||
                                                    index + 1}
                                            </span>
                                        )}
                                    </div>

                                    {/* Book Cover (small) */}
                                    <Link href={`/audiobooks/${book.id}`}>
                                        <div className="relative w-12 h-12 rounded overflow-hidden bg-surface-elevated flex-shrink-0 cursor-pointer">
                                            {book.coverUrl &&
                                            getCoverUrl(book.coverUrl, 100) ? (
                                                <Image
                                                    src={
                                                        getCoverUrl(
                                                            book.coverUrl,
                                                            100,
                                                        )!
                                                    }
                                                    alt={book.title}
                                                    fill
                                                    sizes="48px"
                                                    className="object-cover"
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center">
                                                    <Book className="h-6 w-6 text-content-muted" />
                                                </div>
                                            )}
                                        </div>
                                    </Link>

                                    {/* Book Title & Author */}
                                    <Link
                                        href={`/audiobooks/${book.id}`}
                                        className="flex-1 min-w-0 cursor-pointer"
                                    >
                                        <h3 className="truncate font-medium text-content hover:underline">
                                            {book.title}
                                        </h3>
                                        <p className="truncate text-sm text-content-muted">
                                            {book.narrator || book.author}
                                        </p>
                                    </Link>

                                    {/* Progress/Status */}
                                    {book.progress?.isFinished ? (
                                        <CheckCircle className="h-5 w-5 flex-shrink-0 text-success" />
                                    ) : book.progress &&
                                      book.progress.progress > 0 ? (
                                        <div className="flex items-center gap-2 flex-shrink-0">
                                            <div className="h-1 w-24 overflow-hidden rounded-full bg-surface-elevated">
                                                <div
                                                    className="h-full bg-brand"
                                                    style={{
                                                        width: `${book.progress.progress}%`,
                                                    }}
                                                />
                                            </div>
                                            <span className="text-xs text-content-muted">
                                                {Math.round(
                                                    book.progress.progress,
                                                )}
                                                %
                                            </span>
                                        </div>
                                    ) : null}

                                    {/* Duration */}
                                    <div className="hidden flex-shrink-0 items-center gap-2 text-sm text-content-muted md:flex">
                                        <Clock className="w-4 h-4" />
                                        {formatDuration(book.duration)}
                                    </div>

                                    {/* Play Button */}
                                    <Button
                                        variant={
                                            isCurrentBook ? "primary" : "icon"
                                        }
                                        onClick={() => {
                                            if (isCurrentBook) {
                                                if (isPlaying) {
                                                    pause();
                                                } else {
                                                    resume();
                                                }
                                            } else {
                                                playAudiobook(book);
                                            }
                                        }}
                                        className="flex-shrink-0"
                                        aria-label={
                                            isBookPlaying
                                                ? `Пауза: ${book.title}`
                                                : `Слушать: ${book.title}`
                                        }
                                    >
                                        {isBookPlaying ? (
                                            <Pause className="w-4 h-4" />
                                        ) : (
                                            <Play className="w-4 h-4" />
                                        )}
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
