"use client";

import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    Check,
    ChevronLeft,
    ChevronRight,
    Download,
    Loader2,
    Music,
    Play,
    Radio,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track } from "@/lib/audio-state-context";
import { CachedImage } from "@/components/ui/CachedImage";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import type { PersonalizedTrack } from "../types";
import { useOptionalDeviceOffline } from "@/features/device-offline/DeviceOfflineProvider";
import { getDeviceDownloadSourceUrl } from "@/features/device-offline/sourceUrl";
import { toast } from "sonner";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import { userFacingError } from "@/lib/i18n/ru";
import { getRecommendationSessionId } from "@/lib/recommendationSession";
import { useRecommendationImpressions } from "../hooks/useRecommendationImpressions";
import { recommendationTrackKey } from "../recommendationIdentity";

interface PersonalizedTrackShelfProps {
    title: string;
    subtitle?: string;
    tracks: PersonalizedTrack[];
    generationId?: string;
}

function trackImageUrl(track: PersonalizedTrack): string | null {
    return track.album.coverArt
        ? api.getCoverArtUrl(track.album.coverArt, 160)
        : null;
}

function ArtworkFallback({ title }: { title: string }) {
    return (
        <span
            role="img"
            aria-label={`Обложка для «${title}» недоступна`}
            className="flex h-full w-full items-center justify-center"
        >
            <Music className="h-5 w-5 text-white/35" aria-hidden="true" />
        </span>
    );
}

function PersonalizedDownloadAction({ track }: { track: Track }) {
    const deviceOffline = useOptionalDeviceOffline();
    if (!deviceOffline) return null;
    const record = deviceOffline.recordForTrack(track);
    const busy = record?.status === "downloading";
    const ready = record?.status === "ready";
    const autoManagedReady = ready && record.management === "auto-liked";
    const storageStatus = deviceOffline.storage.status;
    const storageBlocked =
        storageStatus === "unsupported" ||
        storageStatus === "checking" ||
        storageStatus === "requesting";
    const disabled = busy || (ready && !autoManagedReady) || storageBlocked;
    const actionCopy = (() => {
        if (ready && !autoManagedReady) {
            return {
                ariaLabel: `Трек «${track.title}» доступен офлайн`,
                title: "Доступен офлайн",
            };
        }
        if (busy) {
            return {
                ariaLabel: `Скачивается «${track.title}»`,
                title: "Скачивание…",
            };
        }
        if (storageStatus === "unsupported") {
            return {
                ariaLabel:
                    "Скачивание на устройство недоступно в этом браузере",
                title: "Скачивание недоступно в этом браузере",
            };
        }
        if (storageStatus === "checking") {
            return {
                ariaLabel: `Проверяем хранилище перед скачиванием «${track.title}»`,
                title: "Проверяем хранилище…",
            };
        }
        if (storageStatus === "requesting") {
            return {
                ariaLabel: `Ожидаем доступ к папке для скачивания «${track.title}»`,
                title: "Ожидаем доступ к папке…",
            };
        }
        if (storageStatus === "needs-setup") {
            return {
                ariaLabel: `Выберите папку для скачивания «${track.title}»`,
                title: "Выбрать папку и скачать",
            };
        }
        if (storageStatus === "error") {
            const reconnecting = Boolean(deviceOffline.storage.directoryName);
            return {
                ariaLabel: reconnecting
                    ? `Переподключите папку для скачивания «${track.title}»`
                    : `Выберите папку для скачивания «${track.title}»`,
                title: reconnecting
                    ? "Переподключить папку и скачать"
                    : "Выбрать папку и скачать",
            };
        }
        if (autoManagedReady) {
            return {
                ariaLabel: `Оставить «${track.title}» офлайн на этом устройстве`,
                title: "Оставить офлайн на этом устройстве",
            };
        }
        return {
            ariaLabel: `Скачать «${track.title}» на это устройство`,
            title: "Скачать на устройство",
        };
    })();

    return (
        <button
            type="button"
            disabled={disabled}
            onClick={() => {
                void deviceOffline
                    .download({
                        track,
                        quality: "auto",
                        sourceUrl: getDeviceDownloadSourceUrl(track),
                    })
                    .then((record) =>
                        toast.success(
                            record.status === "ready"
                                ? `«${track.title}» доступен офлайн`
                                : `Началось скачивание «${track.title}»`,
                        ),
                    )
                    .catch((error: unknown) =>
                        toast.error(
                            userFacingError(
                                error,
                                "Не удалось скачать трек на устройство",
                            ),
                        ),
                    );
            }}
            aria-label={actionCopy.ariaLabel}
            title={actionCopy.title}
            className="mr-1 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full text-white/65 transition hover:bg-white/10 hover:text-white disabled:opacity-55 motion-reduce:transition-none"
        >
            {ready && !autoManagedReady ? (
                <Check className="h-4 w-4" aria-hidden="true" />
            ) : busy ? (
                <Loader2
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                />
            ) : (
                <Download className="h-4 w-4" aria-hidden="true" />
            )}
        </button>
    );
}

/** Immediate-play continuation row for the user's personal catalog. */
export function PersonalizedTrackShelf({
    title,
    subtitle,
    tracks,
    generationId,
}: PersonalizedTrackShelfProps) {
    const titleId = useId();
    const { playTracks } = useAudioControls();
    const queue = useMemo(
        () =>
            tracks.map((track) =>
                toProviderPlaybackTrack(track, {
                    generationId,
                    sessionId: getRecommendationSessionId(),
                }),
            ),
        [generationId, tracks],
    );
    const impressionRef = useRecommendationImpressions(generationId, tracks);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const shelfIdentity = `${title}:${tracks.map((track) => track.id).join("|")}`;

    const syncScrollControls = useCallback(() => {
        const container = scrollContainerRef.current;
        if (!container) return;
        setCanScrollLeft(container.scrollLeft > 1);
        setCanScrollRight(
            container.scrollLeft <
                container.scrollWidth - container.clientWidth - 1,
        );
    }, []);

    useLayoutEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;
        container.scrollLeft = 0;
        syncScrollControls();
    }, [shelfIdentity, syncScrollControls]);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;
        syncScrollControls();
        container.addEventListener("scroll", syncScrollControls, {
            passive: true,
        });
        window.addEventListener("resize", syncScrollControls);
        const resizeObserver =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(syncScrollControls);
        resizeObserver?.observe(container);
        return () => {
            container.removeEventListener("scroll", syncScrollControls);
            window.removeEventListener("resize", syncScrollControls);
            resizeObserver?.disconnect();
        };
    }, [shelfIdentity, syncScrollControls]);

    const scrollShelf = (direction: "left" | "right") => {
        const container = scrollContainerRef.current;
        if (!container) return;
        container.scrollBy({
            left:
                direction === "left"
                    ? -container.clientWidth * 0.82
                    : container.clientWidth * 0.82,
            behavior: "smooth",
        });
    };

    if (tracks.length === 0) return null;

    return (
        <section
            ref={impressionRef}
            data-home-rail="tracks"
            aria-labelledby={titleId}
            className="relative min-w-0"
        >
            <div className="mb-3 flex items-end justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                        <h2
                            id={titleId}
                            className="truncate text-xl font-black tracking-[-0.025em] text-content sm:text-2xl"
                        >
                            {title}
                        </h2>
                        <YouTubeBadge />
                    </div>
                    {subtitle && (
                        <p className="mt-1 text-sm text-content-muted">
                            {subtitle}
                        </p>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <div className="hidden items-center gap-1 sm:flex">
                        <button
                            type="button"
                            disabled={!canScrollLeft}
                            onClick={() => scrollShelf("left")}
                            className="grid min-h-11 min-w-11 place-items-center rounded-full border border-white/10 bg-black/30 text-white transition hover:border-white/20 hover:bg-white/10 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:scroll-auto motion-reduce:transition-none"
                            aria-label={`Прокрутить раздел «${title}» влево`}
                        >
                            <ChevronLeft
                                className="h-5 w-5"
                                aria-hidden="true"
                            />
                        </button>
                        <button
                            type="button"
                            disabled={!canScrollRight}
                            onClick={() => scrollShelf("right")}
                            className="grid min-h-11 min-w-11 place-items-center rounded-full border border-white/10 bg-black/30 text-white transition hover:border-white/20 hover:bg-white/10 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:scroll-auto motion-reduce:transition-none"
                            aria-label={`Прокрутить раздел «${title}» вправо`}
                        >
                            <ChevronRight
                                className="h-5 w-5"
                                aria-hidden="true"
                            />
                        </button>
                    </div>
                    <button
                        type="button"
                        onClick={() => playTracks(queue, 0)}
                        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-bold text-black shadow-lg shadow-brand/15 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-black motion-reduce:transition-none"
                        aria-label={`Воспроизвести весь раздел «${title}»`}
                    >
                        <Radio className="h-4 w-4" aria-hidden="true" />
                        <span className="hidden sm:inline">Включить всё</span>
                    </button>
                </div>
            </div>

            <div
                ref={scrollContainerRef}
                role="list"
                data-testid="personalized-track-shelf-scroll"
                className="scrollbar-hide grid touch-pan-x snap-x snap-proximity grid-flow-col auto-cols-[minmax(240px,68vw)] gap-2 overflow-x-auto overscroll-x-contain scroll-smooth sm:auto-cols-[minmax(272px,320px)] motion-reduce:scroll-auto"
            >
                {tracks.map((track, index) => {
                    const imageUrl = trackImageUrl(track);
                    return (
                        <div
                            key={`${track.id}-${index}`}
                            role="listitem"
                            data-recommendation-track-key={recommendationTrackKey(
                                track,
                            )}
                            className="group flex min-h-[72px] snap-start scroll-ml-0 items-center overflow-hidden rounded-2xl bg-white/[0.04] transition duration-200 hover:bg-white/[0.075] motion-reduce:transition-none"
                        >
                            <button
                                type="button"
                                onClick={() => playTracks(queue, index)}
                                aria-label={`Воспроизвести «${track.title}», исполнитель ${track.artist.name}`}
                                className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                            >
                                <span className="relative h-13 w-13 shrink-0 overflow-hidden rounded-lg bg-white/[0.07] shadow-md">
                                    {imageUrl ? (
                                        <CachedImage
                                            src={imageUrl}
                                            alt=""
                                            fill
                                            sizes="52px"
                                            className="object-cover transition duration-300 group-hover:scale-105"
                                            fallback={
                                                <ArtworkFallback
                                                    title={track.title}
                                                />
                                            }
                                        />
                                    ) : (
                                        <ArtworkFallback title={track.title} />
                                    )}
                                    <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                                        <Play
                                            className="h-5 w-5 fill-white text-white"
                                            aria-hidden="true"
                                        />
                                    </span>
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-semibold text-white">
                                        {track.title}
                                    </span>
                                    <span className="mt-0.5 block truncate text-xs text-white/50">
                                        {track.artist.name}
                                        {track.album.title &&
                                        track.album.title !== "Single"
                                            ? ` · ${track.album.title}`
                                            : ""}
                                    </span>
                                </span>
                                <Play
                                    className="mr-1 h-4 w-4 shrink-0 fill-white/70 text-white/70 sm:hidden"
                                    aria-hidden="true"
                                />
                            </button>
                            <PersonalizedDownloadAction track={queue[index]} />
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
