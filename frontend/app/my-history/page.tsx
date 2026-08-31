"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, History, ListMusic } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useToast } from "@/lib/toast-context";
import { PageHeader } from "@/components/layout/PageHeader";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { TrackList } from "@/components/track";
import type {
    TrackRowItem,
    TrackRowSlots,
    OverflowConfig,
} from "@/components/track";
import { pluralRu, ru } from "@/lib/i18n/ru";

interface PlayHistoryTrack {
    id: string;
    title: string;
    displayTitle?: string | null;
    duration: number;
    filePath?: string;
    source?: "local" | "tidal" | "youtube";
    provider?: {
        tidalTrackId: number | null;
        youtubeVideoId: string | null;
    };
    streamSource?: "peer" | "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    artist?: {
        id?: string | null;
        name?: string;
        mbid?: string;
    };
    album?: {
        id?: string | null;
        title?: string;
        coverArt?: string;
        coverUrl?: string;
        artist?: {
            id?: string | null;
            name?: string;
            mbid?: string;
        };
    };
}

interface PlayHistoryEntry {
    id: string;
    playedAt: string;
    track: PlayHistoryTrack;
}

function toAudioTrack(track: PlayHistoryTrack) {
    const artist = track.artist ?? track.album?.artist;
    const streamSource =
        track.streamSource ??
        (track.source === "tidal" || track.source === "youtube"
            ? track.source
            : undefined);

    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        duration: track.duration,
        filePath: track.filePath,
        streamSource,
        tidalTrackId:
            track.tidalTrackId ?? track.provider?.tidalTrackId ?? undefined,
        youtubeVideoId:
            track.youtubeVideoId ?? track.provider?.youtubeVideoId ?? undefined,
        artist: {
            id: artist?.id ?? undefined,
            name: artist?.name || ru.common.unknownArtist,
            mbid: artist?.mbid,
        },
        album: {
            id: track.album?.id ?? undefined,
            title: track.album?.title || ru.common.unknownAlbum,
            coverArt:
                track.album?.coverArt || track.album?.coverUrl || undefined,
        },
    };
}

function formatPlayedAt(isoDate: string): string {
    const parsed = Date.parse(isoDate);
    if (Number.isNaN(parsed)) return "";

    const diffMs = Date.now() - parsed;
    if (diffMs < 60_000) return "только что";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} мин. назад`;
    if (diffMs < 86_400_000)
        return `${Math.floor(diffMs / 3_600_000)} ч. назад`;
    return new Date(parsed).toLocaleDateString("ru-RU");
}

function historyToRowItem(entry: PlayHistoryEntry): TrackRowItem {
    const track = entry.track;
    const streamSource =
        track.streamSource ??
        (track.source === "tidal" || track.source === "youtube"
            ? track.source
            : undefined);
    const isRemote = streamSource === "tidal" || streamSource === "youtube";
    const coverArt = track.album?.coverArt || track.album?.coverUrl;
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        artistName:
            track.artist?.name ||
            track.album?.artist?.name ||
            ru.common.unknownArtist,
        duration: track.duration,
        coverArtUrl: coverArt
            ? isRemote
                ? api.getBrowseImageUrl(coverArt)
                : api.getCoverArtUrl(coverArt, 100)
            : null,
    };
}

/**
 * Renders the MyHistoryPage component.
 */
export default function MyHistoryPage() {
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { playTracks } = useAudioControls();
    const { toast } = useToast();
    const [history, setHistory] = useState<PlayHistoryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!isAuthenticated) {
            router.push("/login");
            return;
        }

        const loadHistory = async () => {
            try {
                setLoading(true);
                setError(null);
                const data =
                    await api.get<PlayHistoryEntry[]>("/plays?limit=250");
                setHistory(
                    Array.isArray(data)
                        ? data.filter((entry) => Boolean(entry.track?.id))
                        : [],
                );
            } catch (err) {
                sharedFrontendLogger.error("Failed to load play history:", err);
                setError("Не удалось загрузить историю прослушиваний");
            } finally {
                setLoading(false);
            }
        };

        void loadHistory();
    }, [isAuthenticated, router]);

    const audioTracks = useMemo(
        () => history.map((entry) => toAudioTrack(entry.track)),
        [history],
    );

    const handlePlayFromHistory = useCallback(
        (_entry: PlayHistoryEntry, index: number) => {
            if (audioTracks.length === 0) return;
            playTracks(audioTracks, index);
            toast.success("Воспроизводим из истории");
        },
        [audioTracks, playTracks, toast],
    );

    const historyRowSlots = useCallback(
        (entry: PlayHistoryEntry): TrackRowSlots => {
            const track = entry.track;
            const streamSource =
                track.streamSource ??
                (track.source === "tidal" || track.source === "youtube"
                    ? track.source
                    : undefined);
            const isRemote =
                streamSource === "tidal" || streamSource === "youtube";
            return {
                leadingColumn: null,
                subtitleExtra: (
                    <>
                        {isRemote && (
                            <div className="mt-1 flex items-center gap-1.5">
                                {streamSource === "tidal" ? (
                                    <TidalBadge />
                                ) : (
                                    <YouTubeBadge />
                                )}
                            </div>
                        )}
                        <p className="truncate text-[11px] text-content-muted">
                            {track.album?.title || ru.common.unknownAlbum}
                        </p>
                        <p className="mt-1 text-[11px] text-content-muted">
                            Слушали {formatPlayedAt(entry.playedAt)}
                        </p>
                    </>
                ),
            };
        },
        [],
    );

    const historyRowOverflow = useCallback(
        (entry: PlayHistoryEntry): OverflowConfig => ({
            track: toAudioTrack(entry.track),
        }),
        [],
    );

    if (!isAuthenticated) {
        return null;
    }

    if (loading) {
        return <LoadingScreen message="Загружаем историю…" />;
    }

    return (
        <div
            data-consumer-surface="history"
            className="min-h-screen bg-surface"
        >
            <div className="mx-auto max-w-5xl space-y-10 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                <PageHeader
                    title="История прослушиваний"
                    subtitle={`${history.length} ${pluralRu(history.length, [
                        "прослушанный трек",
                        "прослушанных трека",
                        "прослушанных треков",
                    ])}`}
                    icon={History}
                    className="mb-8"
                    actions={
                        <Button
                            variant="secondary"
                            onClick={() => router.push("/queue")}
                        >
                            <ListMusic className="h-4 w-4" aria-hidden="true" />
                            Очередь
                        </Button>
                    }
                />

                {error && (
                    <section
                        data-consumer-state="error"
                        className="border-y border-line"
                    >
                        <EmptyState
                            icon={<AlertCircle />}
                            title={error}
                            description="Проверьте соединение и попробуйте загрузить историю ещё раз."
                            action={{
                                label: "Повторить",
                                onClick: () => window.location.reload(),
                                variant: "secondary",
                            }}
                        />
                    </section>
                )}

                {!error && history.length === 0 && (
                    <section
                        data-consumer-state="empty"
                        className="border-y border-line"
                    >
                        <EmptyState
                            icon={<History />}
                            title="История пока пуста"
                            description="Начните слушать музыку — недавние треки появятся здесь."
                            action={{
                                label: "Открыть коллекцию",
                                onClick: () => router.push("/library"),
                            }}
                        />
                    </section>
                )}

                {!error && history.length > 0 && (
                    <section className="border-t border-line pt-6">
                        <h2 className="mb-4 text-2xl font-black tracking-[-0.03em] text-content">
                            Недавно слушали ({history.length})
                        </h2>

                        <div className="overflow-hidden border-y border-line">
                            <TrackList<PlayHistoryEntry>
                                items={history}
                                toRowItem={historyToRowItem}
                                onPlay={handlePlayFromHistory}
                                rowSlots={historyRowSlots}
                                rowOverflow={historyRowOverflow}
                                rowClassName="grid-cols-[minmax(0,1fr)_auto] px-3 py-4 hover:bg-surface-elevated/70 sm:px-4"
                                preferenceMode="up-only"
                                className="divide-y divide-line"
                            />
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}
