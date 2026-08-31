"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { usePlaylistsQuery } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { useAuth } from "@/lib/auth-context";
import { useAudioControls } from "@/lib/audio-context";
import {
    Play,
    Music,
    Eye,
    EyeOff,
    Loader2,
    Heart,
    Download,
    ListMusic,
    Plus,
} from "lucide-react";
import { usePeerPlaylists } from "@/features/social/hooks/usePeerPlaylists";
import type { PeerPlaylistSummary } from "@/lib/api/peerPlaylists";
import { useFeatures } from "@/lib/features-context";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { peerPlaylistHref } from "@/lib/unifiedPlaylists";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { PageHeader } from "@/components/layout/PageHeader";
import { CoverMosaic } from "@/components/ui/CoverMosaic";
import {
    createMosaicCandidates,
    selectMosaicCovers,
} from "@/utils/mosaicCoverSelection";
import { useLikedPlaylistQuery } from "@/hooks/useQueries";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { pluralRu, ru } from "@/lib/i18n/ru";
import { CreatePlaylistDialog } from "@/features/playlist/components/CreatePlaylistDialog";
import { shouldOpenCreatePlaylist } from "@/features/playlist/createPlaylistRoute";

interface PlaylistItem {
    id: string;
    track: {
        album?: {
            coverArt?: string;
        };
    };
}

type PlaylistOrigin = "all" | "local" | "peers";

interface Playlist {
    id: string;
    name: string;
    trackCount?: number;
    items?: PlaylistItem[];
    isOwner?: boolean;
    isHidden?: boolean;
    user?: {
        username: string;
    };
}

function PlaylistMosaic({
    items,
    size = 4,
    greyed = false,
}: {
    items?: PlaylistItem[];
    size?: number;
    greyed?: boolean;
}) {
    const coverUrls = useMemo(() => {
        if (!items || items.length === 0) return [];
        const candidates = createMosaicCandidates(items, {
            getId: (item) => item.id,
            getCoverUrl: (item) => item.track?.album?.coverArt,
        });
        return selectMosaicCovers(candidates, { count: size }).map((r) =>
            api.getCoverArtUrl(r.coverUrl, 200),
        );
    }, [items, size]);

    return (
        <CoverMosaic
            coverUrls={coverUrls}
            greyed={greyed}
            imageSizes="200px"
            showEmptyCellIcon
            emptyState={
                <div
                    className={cn(
                        "w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-highlight to-surface-elevated",
                        greyed && "opacity-50",
                    )}
                >
                    <Music className="h-10 w-10 text-content-muted" />
                </div>
            }
        />
    );
}

function PlaylistCard({
    playlist,
    index,
    onPlay,
    onToggleHide,
    isHiddenView = false,
}: {
    playlist: Playlist;
    index: number;
    onPlay: (playlistId: string) => void;
    onToggleHide: (playlistId: string, hide: boolean) => void;
    isHiddenView?: boolean;
}) {
    const isShared = playlist.isOwner === false;
    const [isHiding, setIsHiding] = useState(false);
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();

    const handleToggleHide = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsHiding(true);
        try {
            await onToggleHide(playlist.id, !playlist.isHidden);
        } finally {
            setIsHiding(false);
        }
    };

    return (
        <Link
            href={`/playlist/${playlist.id}`}
            className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
        >
            <div
                className={cn(
                    "group cursor-pointer rounded-xl p-1.5 transition duration-200 hover:-translate-y-0.5 hover:bg-surface-elevated/60 motion-reduce:transform-none motion-reduce:transition-none sm:p-2",
                    isHiddenView && "opacity-60 hover:opacity-100",
                )}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                {/* Cover Image */}
                <div className="relative mb-3 aspect-square overflow-hidden rounded-xl bg-surface-highlight shadow-lg shadow-black/20">
                    <PlaylistMosaic
                        items={playlist.items}
                        greyed={isHiddenView}
                    />

                    {/* Hide/Unhide button for shared playlists */}
                    {isShared && (
                        <button
                            onClick={handleToggleHide}
                            disabled={isHiding}
                            className={cn(
                                "absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full",
                                "bg-surface-overlay/90 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100",
                                playlist.isHidden
                                    ? "text-success"
                                    : "text-content-muted",
                                isHiding && "opacity-50 cursor-not-allowed",
                            )}
                            title={
                                playlist.isHidden
                                    ? "Показывать плейлист"
                                    : "Скрыть плейлист"
                            }
                            aria-label={
                                playlist.isHidden
                                    ? "Показывать плейлист"
                                    : "Скрыть плейлист"
                            }
                        >
                            {playlist.isHidden ? (
                                <Eye className="w-3.5 h-3.5" />
                            ) : (
                                <EyeOff className="w-3.5 h-3.5" />
                            )}
                        </button>
                    )}

                    {/* Play button overlay */}
                    <button
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            triggerPlayFeedback();
                            onPlay(playlist.id);
                        }}
                        className={cn(
                            "absolute bottom-2 right-2 flex h-11 w-11 items-center justify-center rounded-full bg-brand text-surface",
                            "shadow-lg shadow-black/40 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none",
                            "hover:scale-105 hover:bg-brand-hover",
                            "opacity-100 sm:translate-y-2 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100 sm:focus-visible:translate-y-0 sm:focus-visible:opacity-100",
                        )}
                        title="Воспроизвести плейлист"
                        aria-label={`Воспроизвести плейлист ${playlist.name}`}
                    >
                        {showPlaySpinner ? (
                            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                        ) : (
                            <Play className="ml-0.5 h-4 w-4 fill-current" />
                        )}
                    </button>
                </div>

                {/* Title and info */}
                <h3
                    className={cn(
                        "text-sm font-semibold truncate",
                        isHiddenView ? "text-content-muted" : "text-content",
                    )}
                >
                    {playlist.name}
                </h3>
                <p className="mt-0.5 truncate text-xs text-content-muted">
                    {isShared && playlist.user?.username ? (
                        <span className="text-content-muted">
                            Автор: {playlist.user.username} ·{" "}
                        </span>
                    ) : null}
                    {playlist.trackCount || 0}{" "}
                    {pluralRu(playlist.trackCount || 0, [
                        "трек",
                        "трека",
                        "треков",
                    ])}
                </p>
            </div>
        </Link>
    );
}

/**
 * Renders the PlaylistsPage component.
 */
/** Grid card for a federated peer playlist: badge, placeholder art, peer link. */
function PeerPlaylistCard({
    playlist,
    index,
}: {
    playlist: PeerPlaylistSummary;
    index: number;
}) {
    return (
        <Link
            href={peerPlaylistHref(playlist.peer.id, playlist.remoteId)}
            className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
        >
            <div
                className="group cursor-pointer rounded-xl p-1.5 transition duration-200 hover:-translate-y-0.5 hover:bg-surface-elevated/60 motion-reduce:transform-none motion-reduce:transition-none sm:p-2"
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="relative mb-3 flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-linear-to-br from-surface-highlight to-surface-elevated shadow-lg shadow-black/20">
                    <ListMusic className="h-10 w-10 text-content-muted" />
                    <div className="absolute top-2 left-2">
                        <PeerBadge
                            peerName={playlist.peer.name}
                            online={true}
                        />
                    </div>
                </div>
                <h3 className="truncate text-sm font-semibold text-content">
                    {playlist.name}
                </h3>
                <p className="mt-0.5 truncate text-xs text-content-muted">
                    Автор: {playlist.owner.displayName} · {playlist.trackCount}{" "}
                    {pluralRu(playlist.trackCount, ["трек", "трека", "треков"])}
                </p>
            </div>
        </Link>
    );
}

export default function PlaylistsPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    useAuth();
    const { playTracks } = useAudioControls();
    const queryClient = useQueryClient();
    const [showHiddenTab, setShowHiddenTab] = useState(false);
    const [origin, setOrigin] = useState<PlaylistOrigin>("all");
    const [isCreateDialogOpenManually, setIsCreateDialogOpenManually] =
        useState(false);
    const likedQuery = useLikedPlaylistQuery(1);
    const likedTotal = likedQuery.data?.total ?? 0;
    const { federation } = useFeatures();
    const { playlists: peerPlaylists } = usePeerPlaylists();

    // Use React Query hook for playlists
    const { data: playlists = [], isLoading } = usePlaylistsQuery();
    const isCreateDialogOpen =
        isCreateDialogOpenManually ||
        shouldOpenCreatePlaylist(searchParams.get("create"));

    // Separate visible and hidden playlists
    const { visiblePlaylists, hiddenPlaylists } = useMemo(() => {
        const visible: Playlist[] = [];
        const hidden: Playlist[] = [];

        playlists.forEach((p: Playlist) => {
            if (p.isHidden) {
                hidden.push(p);
            } else {
                visible.push(p);
            }
        });

        return { visiblePlaylists: visible, hiddenPlaylists: hidden };
    }, [playlists]);

    // Listen for playlist events and invalidate cache
    useEffect(() => {
        const handlePlaylistEvent = () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        };

        window.addEventListener("playlist-created", handlePlaylistEvent);
        window.addEventListener("playlist-updated", handlePlaylistEvent);
        window.addEventListener("playlist-deleted", handlePlaylistEvent);

        return () => {
            window.removeEventListener("playlist-created", handlePlaylistEvent);
            window.removeEventListener("playlist-updated", handlePlaylistEvent);
            window.removeEventListener("playlist-deleted", handlePlaylistEvent);
        };
    }, [queryClient]);

    const handlePlayPlaylist = async (playlistId: string) => {
        try {
            const playlist = await api.getPlaylist(playlistId);
            if (playlist?.items && playlist.items.length > 0) {
                const tracks = playlist.items.flatMap((item) => {
                    if (!item.track || item.playback?.isPlayable === false) {
                        return [];
                    }
                    return [
                        {
                            id: item.track.id,
                            title: item.track.title,
                            artist: {
                                name:
                                    item.track.album?.artist?.name ||
                                    ru.common.unknownArtist,
                                id: item.track.album?.artist?.id,
                            },
                            album: {
                                title:
                                    item.track.album?.title ||
                                    ru.common.unknownAlbum,
                                coverArt: item.track.album?.coverArt,
                                id: item.track.album?.id,
                            },
                            duration: item.track.duration,
                        },
                    ];
                });
                playTracks(tracks, 0);
            }
        } catch (error) {
            sharedFrontendLogger.error("Failed to play playlist:", error);
        }
    };

    const handleToggleHide = async (playlistId: string, hide: boolean) => {
        try {
            if (hide) {
                await api.hidePlaylist(playlistId);
            } else {
                await api.unhidePlaylist(playlistId);
            }
            // Invalidate and refetch playlists
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to toggle playlist visibility:",
                error,
            );
        }
    };

    if (isLoading) {
        return <LoadingScreen message="Загружаем плейлисты…" />;
    }

    // A stored "peers" origin degrades to "all" if federation is off so the
    // grid never renders empty with the source controls hidden.
    const effectiveOrigin: PlaylistOrigin = federation ? origin : "all";
    const displayedPlaylists = showHiddenTab
        ? hiddenPlaylists
        : effectiveOrigin === "peers"
          ? []
          : visiblePlaylists;
    const displayedPeerPlaylists =
        federation && !showHiddenTab && effectiveOrigin !== "local"
            ? peerPlaylists
            : [];
    const totalShown =
        displayedPlaylists.length + displayedPeerPlaylists.length;
    // The subtitle always describes the visible (non-hidden) spectrum, even
    // while the hidden tab is open — matching the pre-merge behavior.
    const subtitleCount =
        (effectiveOrigin === "peers" ? 0 : visiblePlaylists.length) +
        (federation && effectiveOrigin !== "local" ? peerPlaylists.length : 0);
    const showLikedCard =
        !showHiddenTab && effectiveOrigin !== "peers" && likedTotal > 0;

    return (
        <div
            data-consumer-surface="playlists"
            className="min-h-screen bg-surface"
        >
            <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                <PageHeader
                    title="Плейлисты"
                    subtitle={`${subtitleCount} ${pluralRu(subtitleCount, [
                        "плейлист",
                        "плейлиста",
                        "плейлистов",
                    ])}`}
                    icon={Music}
                    className="mb-4"
                    actions={
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() =>
                                    setIsCreateDialogOpenManually(true)
                                }
                                className="flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                            >
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                Создать плейлист
                            </button>
                            {federation && !showHiddenTab && (
                                <div
                                    role="group"
                                    aria-label="Источник плейлистов"
                                    className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface-elevated p-1"
                                >
                                    {(
                                        [
                                            ["all", "Все"],
                                            ["local", "Мои"],
                                            ["peers", "Друзья"],
                                        ] as const
                                    ).map(([value, label]) => (
                                        <button
                                            key={value}
                                            onClick={() => setOrigin(value)}
                                            aria-pressed={
                                                effectiveOrigin === value
                                            }
                                            className={cn(
                                                "min-h-11 rounded-lg px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                                effectiveOrigin === value
                                                    ? "bg-brand text-surface"
                                                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                                            )}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <Link
                                href="/import"
                                className="flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-surface-elevated px-4 py-2 text-sm font-semibold text-content transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                            >
                                <Download className="w-3.5 h-3.5" />
                                Импортировать
                            </Link>
                            <Link
                                href="/explore"
                                className="flex min-h-11 items-center rounded-xl border border-line bg-surface-elevated px-4 py-2 text-sm font-semibold text-content transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                            >
                                Найти плейлисты
                            </Link>

                            {hiddenPlaylists.length > 0 && (
                                <button
                                    onClick={() =>
                                        setShowHiddenTab(!showHiddenTab)
                                    }
                                    className={cn(
                                        "min-h-11 rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                        showHiddenTab
                                            ? "bg-surface-hover text-content"
                                            : "text-content-muted hover:bg-surface-elevated hover:text-content",
                                    )}
                                >
                                    {showHiddenTab
                                        ? "Показать все"
                                        : `Скрытые (${hiddenPlaylists.length})`}
                                </button>
                            )}
                        </div>
                    }
                />
                {/* Hidden playlists notice */}
                {showHiddenTab && (
                    <div className="mb-6 border-y border-line px-1 py-4">
                        <p className="text-sm leading-6 text-content-muted">
                            Скрытые плейлисты не отображаются в коллекции.
                            Нажмите значок глаза, чтобы вернуть плейлист.
                        </p>
                    </div>
                )}

                {totalShown > 0 || showLikedCard ? (
                    <div
                        data-tv-section="playlists"
                        className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7"
                    >
                        {/* Pinned: My Liked */}
                        {showLikedCard && (
                            <Link
                                href="/playlist/my-liked"
                                className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                            >
                                <div
                                    className="group cursor-pointer rounded-xl p-1.5 transition duration-200 hover:-translate-y-0.5 hover:bg-surface-elevated/60 motion-reduce:transform-none motion-reduce:transition-none sm:p-2"
                                    data-tv-card
                                    data-tv-card-index={0}
                                    tabIndex={0}
                                >
                                    <div className="relative mb-3 flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-linear-to-br from-brand to-brand-dark shadow-lg shadow-black/20">
                                        <Heart className="h-12 w-12 fill-current text-content" />
                                    </div>
                                    <h3 className="truncate text-sm font-semibold text-content">
                                        Любимые треки
                                    </h3>
                                    <p className="mt-0.5 truncate text-xs text-content-muted">
                                        {likedTotal}{" "}
                                        {pluralRu(likedTotal, [
                                            "трек",
                                            "трека",
                                            "треков",
                                        ])}
                                    </p>
                                </div>
                            </Link>
                        )}
                        {displayedPlaylists.map(
                            (playlist: Playlist, index: number) => (
                                <PlaylistCard
                                    key={playlist.id}
                                    playlist={playlist}
                                    index={showLikedCard ? index + 1 : index}
                                    onPlay={handlePlayPlaylist}
                                    onToggleHide={handleToggleHide}
                                    isHiddenView={showHiddenTab}
                                />
                            ),
                        )}
                        {displayedPeerPlaylists.map((playlist, index) => (
                            <PeerPlaylistCard
                                key={`peer:${playlist.peer.id}:${playlist.remoteId}`}
                                playlist={playlist}
                                index={
                                    displayedPlaylists.length +
                                    index +
                                    (showLikedCard ? 1 : 0)
                                }
                            />
                        ))}
                    </div>
                ) : (
                    <section
                        data-consumer-state="empty"
                        className="border-y border-line"
                    >
                        <EmptyState
                            icon={<Music />}
                            title={
                                showHiddenTab
                                    ? "Скрытых плейлистов нет"
                                    : effectiveOrigin === "peers"
                                      ? "У друзей нет доступных плейлистов"
                                      : "Плейлистов пока нет"
                            }
                            description={
                                showHiddenTab
                                    ? "Вы ещё не скрывали плейлисты"
                                    : effectiveOrigin === "peers"
                                      ? "Друзья ещё не поделились плейлистами или сейчас недоступны"
                                      : "Создайте первый плейлист, добавив треки из альбома или со страницы исполнителя"
                            }
                            action={
                                !showHiddenTab && effectiveOrigin !== "peers"
                                    ? {
                                          label: "Создать плейлист",
                                          onClick: () =>
                                              setIsCreateDialogOpenManually(
                                                  true,
                                              ),
                                      }
                                    : undefined
                            }
                        />
                    </section>
                )}
            </div>
            <CreatePlaylistDialog
                isOpen={isCreateDialogOpen}
                onClose={() => {
                    setIsCreateDialogOpenManually(false);
                    if (shouldOpenCreatePlaylist(searchParams.get("create"))) {
                        router.replace("/playlists", { scroll: false });
                    }
                }}
                onCreated={(playlist) =>
                    router.push(`/playlist/${encodeURIComponent(playlist.id)}`)
                }
            />
        </div>
    );
}
