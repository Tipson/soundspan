"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { Mic2, ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface Podcast {
    id: string;
    title: string;
    author: string;
    coverUrl: string;
    feedUrl: string;
    itunesId?: number;
}

const GENRE_MAP: { [key: string]: { name: string; searchTerm: string } } = {
    "1303": { name: "Комедия", searchTerm: "comedy podcast" },
    "1324": {
        name: "Общество и культура",
        searchTerm: "society culture podcast",
    },
    "1489": { name: "Новости", searchTerm: "news podcast" },
    "1488": { name: "Криминальные истории", searchTerm: "true crime podcast" },
    "1321": { name: "Бизнес", searchTerm: "business podcast" },
    "1545": { name: "Спорт", searchTerm: "sports podcast" },
    "1502": { name: "Досуг", searchTerm: "gaming hobbies podcast" },
};

/**
 * Renders the GenrePage component.
 */
export default function GenrePage() {
    const params = useParams();
    const router = useRouter();
    const genreId = params.genreId as string;
    const genre = GENRE_MAP[genreId];

    const [podcasts, setPodcasts] = useState<Podcast[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [offset, setOffset] = useState(0);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const loadMoreRef = useRef<HTMLDivElement>(null);

    const LIMIT = 20;

    const loadMorePodcasts = useCallback(async () => {
        if (loading || !hasMore) return;

        setLoading(true);
        try {
            // Call the paginated endpoint
            const data = await api.getPodcastsByGenrePaginated(
                parseInt(genreId),
                LIMIT,
                offset,
            );

            if (data.length < LIMIT) {
                setHasMore(false);
            }

            setPodcasts((prev) => [...prev, ...data]);
            setOffset((prev) => prev + data.length);
        } catch (error) {
            sharedFrontendLogger.error("Failed to load podcasts:", error);
            setHasMore(false);
        } finally {
            setLoading(false);
        }
    }, [genreId, offset, loading, hasMore]);

    // Set up intersection observer for infinite scroll
    useEffect(() => {
        if (observerRef.current) observerRef.current.disconnect();

        observerRef.current = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !loading) {
                    loadMorePodcasts();
                }
            },
            { threshold: 0.1 },
        );

        if (loadMoreRef.current) {
            observerRef.current.observe(loadMoreRef.current);
        }

        return () => {
            if (observerRef.current) {
                observerRef.current.disconnect();
            }
        };
    }, [loadMorePodcasts, hasMore, loading]);

    // Load initial podcasts
    useEffect(() => {
        const initialLoadTimer = window.setTimeout(() => {
            void loadMorePodcasts();
        }, 0);

        return () => window.clearTimeout(initialLoadTimer);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: initial load should not re-trigger when loadMorePodcasts identity changes
    }, []);

    const handlePodcastClick = (podcast: Podcast) => {
        // Navigate to podcast preview page instead of auto-subscribing
        router.push(`/podcasts/${podcast.id || podcast.itunesId}`);
    };

    if (!genre) {
        return (
            <div
                data-routed-surface="podcast-genre"
                className="min-h-screen bg-surface px-4 py-8"
            >
                <EmptyState
                    icon={<Mic2 />}
                    title="Жанр не найден"
                    description="Вернитесь к каталогу подкастов и выберите другой жанр."
                    action={{
                        label: "К подкастам",
                        onClick: () => router.push("/podcasts"),
                    }}
                />
            </div>
        );
    }

    return (
        <div
            data-routed-surface="podcast-genre"
            className="min-h-screen bg-surface"
        >
            <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                <PageHeader
                    title={genre.name}
                    subtitle={`${podcasts.length} ${
                        podcasts.length % 10 === 1 &&
                        podcasts.length % 100 !== 11
                            ? "подкаст"
                            : podcasts.length % 10 >= 2 &&
                                podcasts.length % 10 <= 4 &&
                                (podcasts.length % 100 < 10 ||
                                    podcasts.length % 100 >= 20)
                              ? "подкаста"
                              : "подкастов"
                    }`}
                    icon={Mic2}
                    actions={
                        <button
                            type="button"
                            aria-label="Назад к подкастам"
                            onClick={() => router.push("/podcasts")}
                            className="flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface-elevated px-4 text-sm font-semibold text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            <ArrowLeft className="h-5 w-5" />
                            <span className="hidden sm:inline">
                                Назад к подкастам
                            </span>
                        </button>
                    }
                />

                {/* Podcast Grid */}
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                    {podcasts.map((podcast) => (
                        <button
                            type="button"
                            key={podcast.id}
                            onClick={() => handlePodcastClick(podcast)}
                            className="group w-full rounded-xl p-1.5 text-left transition duration-200 hover:-translate-y-0.5 hover:bg-surface-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none sm:p-2"
                        >
                            <div className="relative mb-3 aspect-square w-full overflow-hidden rounded-full bg-surface-elevated shadow-lg shadow-black/20">
                                {podcast.coverUrl ? (
                                    <Image
                                        src={podcast.coverUrl}
                                        alt={podcast.title}
                                        fill
                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                        className="object-cover transition-transform duration-200 group-hover:scale-105 motion-reduce:transform-none motion-reduce:transition-none"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="flex h-full w-full items-center justify-center">
                                        <Mic2 className="h-16 w-16 text-content-muted" />
                                    </div>
                                )}
                            </div>
                            <h3 className="truncate text-sm font-bold text-content">
                                {podcast.title}
                            </h3>
                            <p className="truncate text-xs text-content-muted">
                                {podcast.author}
                            </p>
                        </button>
                    ))}
                </div>

                {/* Loading indicator */}
                {loading && (
                    <div
                        className="flex items-center justify-center py-8"
                        role="status"
                        aria-label="Загружаем подкасты"
                    >
                        <GradientSpinner size="md" />
                    </div>
                )}

                {/* Intersection observer target */}
                <div ref={loadMoreRef} className="h-20" />

                {/* End of results */}
                {!hasMore && podcasts.length > 0 && (
                    <div className="border-t border-line py-8 text-center text-content-muted">
                        Вы посмотрели все подкасты
                    </div>
                )}

                {/* No results */}
                {!loading && podcasts.length === 0 && (
                    <section className="border-y border-line">
                        <EmptyState
                            icon={<Mic2 />}
                            title="Подкасты не найдены"
                            description="Попробуйте открыть другой жанр или вернитесь в общий каталог."
                        />
                    </section>
                )}
            </div>
        </div>
    );
}
