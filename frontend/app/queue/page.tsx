"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Virtuoso } from "react-virtuoso";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAudioState, useAudioControls } from "@/lib/audio-context";
import {
    resolveDropPosition,
    resolveDropTargetIndex,
    type DropPosition,
} from "@/components/track/reorderDnd";
import type { Track } from "@/lib/audio-state-context";
import { isEpisodeQueueItem, type EpisodeQueueItem } from "@/lib/queue-item";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { api } from "@/lib/api";
import { useListenTogether } from "@/lib/listen-together-context";
import { PageHeader } from "@/components/layout/PageHeader";
import type { AvailabilityItem } from "@/lib/listen-together-socket";

import {
    Music,
    Play,
    GripVertical,
    Trash2,
    ListMusic,
    ChevronUp,
    ChevronDown,
    X,
    Save,
} from "lucide-react";
import {
    TrackOverflowMenu,
    TrackMenuButton,
} from "@/components/ui/TrackOverflowMenu";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { formatTime } from "@/utils/formatTime";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { PeerBadge } from "@/components/ui/PeerBadge";
import {
    formatQueueCount,
    formatQueueSaveDescription,
    formatQueueSaved,
    queueRu,
} from "@/lib/i18n/musicPagesRu";

/**
 * Rows rendered on the first pass before react-virtuoso measures the
 * viewport; keeps first paint windowed instead of mounting the whole queue
 * (GH #784).
 */
const INITIAL_WINDOW_COUNT = 20;

/**
 * Renders the QueuePage component.
 */
export default function QueuePage() {
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { queue, currentTrack, currentIndex } = useAudioState();
    const { playQueueIndex, removeFromQueue, clearQueue, moveQueueItem } =
        useAudioControls();
    const { toast } = useToast();
    const listenTogether = useListenTogether();
    const { isInGroup, isHost, syncSetTrack } = listenTogether;
    const trackAvailability = listenTogether.trackAvailability ?? new Map();

    useEffect(() => {
        if (!isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, router]);

    const resolveQueueSource = (
        index: number,
        fallback?: "peer" | "tidal" | "youtube" | "youtube-direct",
    ): "local" | "peer" | "tidal" | "youtube" => {
        const resolved = trackAvailability.get(index)?.source;
        if (
            resolved === "local" ||
            resolved === "peer" ||
            resolved === "tidal" ||
            resolved === "youtube"
        ) {
            return resolved;
        }
        if (
            fallback === "peer" ||
            fallback === "tidal" ||
            fallback === "youtube"
        ) {
            return fallback;
        }
        if (fallback === "youtube-direct") {
            return "youtube";
        }
        return "local";
    };

    const handleClearQueue = () => {
        clearQueue();
        toast.success(isInGroup ? queueRu.sharedCleared : queueRu.cleared);
    };

    const handleRemoveTrack = (index: number) => {
        removeFromQueue(index);
        toast.success(queueRu.removed);
    };

    const handlePlayFromQueue = (index: number) => {
        const queueTrack = queue[index];
        if (
            !isEpisodeQueueItem(queueTrack) &&
            queueTrack.source === "federated" &&
            queueTrack.peer?.online === false
        ) {
            toast.info(queueRu.peerOffline);
            return;
        }
        const availability = isInGroup
            ? trackAvailability.get(index)
            : undefined;
        if (availability?.available === false) {
            toast.info(queueRu.unavailableInSession);
            return;
        }
        if (isInGroup) {
            if (!isHost) {
                toast.info(queueRu.hostOnly);
                return;
            }
            syncSetTrack(index);
            return;
        }
        playQueueIndex(index);
        toast.success(queueRu.playingFromQueue);
    };

    // Both the arrow actions and drag-and-drop route through the shared
    // moveQueueItem primitive (LT/current/bounds guards + shuffle-index
    // remapping live there).
    const handleMoveUp = (index: number) => {
        moveQueueItem(index, index - 1);
    };

    const handleMoveDown = (index: number) => {
        moveQueueItem(index, index + 1);
    };

    // Drag-and-drop reorder for the Next Up list (same mechanic and pure
    // drop math as playlist reordering). Indexes here are positions
    // WITHIN nextTracks; moveQueueItem receives absolute queue indexes.
    const dragFromIdxRef = useRef<number | null>(null);
    const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
    const [dragOver, setDragOver] = useState<{
        idx: number;
        position: DropPosition;
    } | null>(null);

    const clearQueueDragState = () => {
        dragFromIdxRef.current = null;
        setDragFromIdx(null);
        setDragOver(null);
    };

    const buildDragHandleProps = (idx: number) =>
        isInGroup
            ? undefined
            : {
                  draggable: true,
                  onClick: (e: React.MouseEvent) => e.stopPropagation(),
                  onDragStart: (e: React.DragEvent) => {
                      dragFromIdxRef.current = idx;
                      setDragFromIdx(idx);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(idx));
                      const row = (e.currentTarget as HTMLElement).closest(
                          "[data-queue-dnd-row]",
                      );
                      if (row instanceof HTMLElement) {
                          e.dataTransfer.setDragImage(
                              row,
                              16,
                              row.clientHeight / 2,
                          );
                      }
                  },
                  onDragEnd: clearQueueDragState,
              };

    const buildRowDropProps = (idx: number) => ({
        "data-queue-dnd-row": true,
        onDragOver: (e: React.DragEvent) => {
            if (dragFromIdxRef.current === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const rect = e.currentTarget.getBoundingClientRect();
            setDragOver({
                idx,
                position: resolveDropPosition(
                    e.clientY - rect.top,
                    rect.height,
                ),
            });
        },
        onDragLeave: (e: React.DragEvent) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDragOver((current) => (current?.idx === idx ? null : current));
        },
        onDrop: (e: React.DragEvent) => {
            const fromIdx = dragFromIdxRef.current;
            if (fromIdx === null) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const toIdx = resolveDropTargetIndex(
                fromIdx,
                idx,
                resolveDropPosition(e.clientY - rect.top, rect.height),
            );
            clearQueueDragState();
            if (toIdx !== fromIdx) {
                moveQueueItem(
                    currentIndex + 1 + fromIdx,
                    currentIndex + 1 + toIdx,
                );
            }
        },
    });

    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [playlistName, setPlaylistName] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    // Podcast episodes cannot be saved to playlists; only track items are.
    const playlistTracks = queue.filter(
        (item): item is Track => !isEpisodeQueueItem(item),
    );

    const handleSaveAsPlaylist = async () => {
        const name =
            playlistName.trim() ||
            `${queueRu.title} — ${new Date().toLocaleDateString("ru-RU")}`;
        setIsSaving(true);
        try {
            const playlist = await api.createPlaylist(name);
            for (const track of playlistTracks) {
                await api.addTrackToPlaylist(
                    playlist.id,
                    toAddToPlaylistRef(track),
                );
            }
            toast.success(formatQueueSaved(playlistTracks.length, name));
            setShowSaveDialog(false);
            setPlaylistName("");
            router.push(`/playlist/${playlist.id}`);
        } catch {
            toast.error(queueRu.saveFailed);
        } finally {
            setIsSaving(false);
        }
    };

    if (!isAuthenticated) {
        return null;
    }

    // Split queue into current, next up, and previous
    const previousTracks = queue.slice(0, currentIndex);
    const nextTracks = queue.slice(currentIndex + 1);
    const currentQueueItem = queue[currentIndex];
    const currentEpisode =
        !currentTrack && isEpisodeQueueItem(currentQueueItem)
            ? currentQueueItem
            : null;
    const currentAvailability = currentTrack
        ? trackAvailability.get(currentIndex)
        : undefined;
    const isCurrentUnavailable = currentAvailability?.available === false;

    return (
        <div data-consumer-surface="queue" className="min-h-screen bg-surface">
            <div className="mx-auto max-w-5xl space-y-10 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                {/* Header */}
                <PageHeader
                    title={isInGroup ? queueRu.sharedTitle : queueRu.title}
                    subtitle={formatQueueCount(queue.length)}
                    icon={ListMusic}
                    iconClassName="text-brand"
                    className="mb-8"
                    actions={
                        queue.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <Button
                                    variant="secondary"
                                    onClick={() => setShowSaveDialog(true)}
                                >
                                    <Save className="w-4 h-4 mr-2" />
                                    {queueRu.saveAsPlaylist}
                                </Button>
                                <Button
                                    variant="secondary"
                                    onClick={handleClearQueue}
                                >
                                    <Trash2 className="w-4 h-4 mr-2" />
                                    {queueRu.clearQueue}
                                </Button>
                            </div>
                        ) : null
                    }
                />

                {/* Empty State */}
                {queue.length === 0 && (
                    <section
                        data-consumer-state="empty"
                        className="border-y border-line"
                    >
                        <EmptyState
                            icon={<ListMusic />}
                            title={queueRu.emptyTitle}
                            description={queueRu.emptyDescription}
                            action={{
                                label: queueRu.browseLibrary,
                                onClick: () => router.push("/library"),
                            }}
                        />
                    </section>
                )}

                {/* Now Playing */}
                {currentTrack && (
                    <section className="border-t border-line pt-6">
                        <h2 className="mb-4 text-2xl font-black tracking-[-0.03em] text-content">
                            {queueRu.nowPlaying}
                        </h2>
                        <div
                            className={`group flex flex-wrap items-center gap-3 border-y border-line bg-surface-elevated/40 px-3 py-4 sm:gap-4 sm:px-4 ${isCurrentUnavailable ? "opacity-50" : ""}`}
                        >
                            <div className="relative flex-shrink-0 w-16 h-16">
                                {currentTrack.album?.coverArt ? (
                                    <Image
                                        src={api.getCoverArtUrl(
                                            currentTrack.album.coverArt,
                                            100,
                                        )}
                                        alt={currentTrack.album.title}
                                        fill
                                        sizes="64px"
                                        className="object-cover rounded-sm"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="w-16 h-16 bg-surface rounded-sm flex items-center justify-center">
                                        <Music className="h-6 w-6 text-content-muted" />
                                    </div>
                                )}
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <Play className="h-6 w-6 animate-pulse fill-brand text-brand motion-reduce:animate-none" />
                                </div>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="truncate text-sm font-semibold text-brand-light">
                                    {currentTrack.displayTitle ??
                                        currentTrack.title}
                                </h3>
                                <p className="truncate text-sm text-content-muted">
                                    {currentTrack.artist?.name}
                                </p>
                                <div className="mt-1 flex items-center gap-2">
                                    {isCurrentUnavailable ? (
                                        <span className="rounded border border-line-strong px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-content-muted">
                                            {queueRu.unavailable}
                                        </span>
                                    ) : null}
                                    {isInGroup &&
                                    resolveQueueSource(
                                        currentIndex,
                                        currentTrack.streamSource,
                                    ) === "tidal" ? (
                                        <TidalBadge />
                                    ) : null}
                                    {isInGroup &&
                                    resolveQueueSource(
                                        currentIndex,
                                        currentTrack.streamSource,
                                    ) === "youtube" ? (
                                        <YouTubeBadge />
                                    ) : null}
                                    {currentTrack.source === "federated" &&
                                    currentTrack.peer ? (
                                        <PeerBadge
                                            peerName={currentTrack.peer.name}
                                            online={currentTrack.peer.online}
                                        />
                                    ) : null}
                                </div>
                                <p className="truncate text-xs text-content-muted">
                                    {currentTrack.album?.title}
                                </p>
                            </div>
                            <div className="ml-auto flex items-center gap-1">
                                <span className="hidden w-10 text-right text-xs tabular-nums text-content-muted sm:block">
                                    {formatTime(currentTrack.duration)}
                                </span>
                                <TrackPreferenceButtons
                                    trackId={currentTrack.id}
                                    mode="up-only"
                                    buttonSizeClassName="h-11 w-11"
                                    iconSizeClassName="h-4 w-4"
                                    metadata={buildPreferenceMetadata(
                                        currentTrack,
                                    )}
                                />
                                <TrackOverflowMenu
                                    track={currentTrack}
                                    triggerClassName="h-11 w-11 p-0"
                                    showPlayNext={false}
                                    showAddToQueue={false}
                                />
                            </div>
                        </div>
                    </section>
                )}

                {/* Now Playing (podcast episode) */}
                {currentEpisode && (
                    <section className="border-t border-line pt-6">
                        <h2 className="mb-4 text-2xl font-black tracking-[-0.03em] text-content">
                            {queueRu.nowPlaying}
                        </h2>
                        <div className="flex flex-wrap items-center gap-3 border-y border-line bg-surface-elevated/40 px-3 py-4 sm:gap-4 sm:px-4">
                            <div className="relative flex-shrink-0 w-16 h-16">
                                {currentEpisode.coverUrl ? (
                                    <Image
                                        src={currentEpisode.coverUrl}
                                        alt={currentEpisode.podcastTitle}
                                        fill
                                        sizes="64px"
                                        className="object-cover rounded-sm"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="w-16 h-16 bg-surface rounded-sm flex items-center justify-center">
                                        <Music className="h-6 w-6 text-content-muted" />
                                    </div>
                                )}
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <Play className="h-6 w-6 animate-pulse fill-brand text-brand motion-reduce:animate-none" />
                                </div>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="truncate text-sm font-semibold text-brand-light">
                                    {currentEpisode.title}
                                </h3>
                                <p className="truncate text-sm text-content-muted">
                                    {currentEpisode.podcastTitle}
                                </p>
                            </div>
                            <span className="ml-auto text-right text-xs tabular-nums text-content-muted">
                                {formatTime(currentEpisode.duration)}
                            </span>
                        </div>
                    </section>
                )}

                {/* Next Up */}
                {nextTracks.length > 0 && (
                    <section
                        data-queue-track-surface="open"
                        className="border-t border-line pt-6"
                    >
                        <h2 className="mb-4 text-2xl font-black tracking-[-0.03em] text-content">
                            {queueRu.nextUp} ({nextTracks.length})
                        </h2>
                        <div className="overflow-hidden border-y border-line">
                            <Virtuoso
                                totalCount={nextTracks.length}
                                initialItemCount={Math.min(
                                    nextTracks.length,
                                    INITIAL_WINDOW_COUNT,
                                )}
                                computeItemKey={(idx) =>
                                    `next-${nextTracks[idx]?.id ?? idx}-${idx}`
                                }
                                style={{
                                    height: Math.min(
                                        nextTracks.length * 80,
                                        600,
                                    ),
                                }}
                                itemContent={(idx) => {
                                    const item = nextTracks[idx];
                                    const queueIndex = currentIndex + 1 + idx;
                                    const row = isEpisodeQueueItem(item) ? (
                                        <EpisodeQueueRow
                                            episode={item}
                                            onPlay={
                                                isInGroup
                                                    ? undefined
                                                    : () =>
                                                          handlePlayFromQueue(
                                                              queueIndex,
                                                          )
                                            }
                                            onRemove={
                                                isInGroup
                                                    ? undefined
                                                    : () =>
                                                          handleRemoveTrack(
                                                              queueIndex,
                                                          )
                                            }
                                            dragHandleProps={buildDragHandleProps(
                                                idx,
                                            )}
                                        />
                                    ) : (
                                        <NextTrackRow
                                            track={item}
                                            queueIndex={queueIndex}
                                            queueLength={queue.length}
                                            currentIndex={currentIndex}
                                            isInGroup={isInGroup}
                                            resolveQueueSource={
                                                resolveQueueSource
                                            }
                                            onMoveUp={handleMoveUp}
                                            onMoveDown={handleMoveDown}
                                            onPlay={handlePlayFromQueue}
                                            onRemove={handleRemoveTrack}
                                            trackAvailability={
                                                trackAvailability
                                            }
                                            dragHandleProps={buildDragHandleProps(
                                                idx,
                                            )}
                                        />
                                    );
                                    return (
                                        <div
                                            className={
                                                dragFromIdx === idx
                                                    ? "relative opacity-50"
                                                    : "relative"
                                            }
                                            {...buildRowDropProps(idx)}
                                        >
                                            {dragOver?.idx === idx &&
                                                dragFromIdx !== idx && (
                                                    <div
                                                        className={`pointer-events-none absolute left-0 right-0 z-10 h-0.5 rounded bg-brand ${
                                                            dragOver.position ===
                                                            "before"
                                                                ? "top-0"
                                                                : "bottom-0"
                                                        }`}
                                                    />
                                                )}
                                            {row}
                                        </div>
                                    );
                                }}
                            />
                        </div>
                    </section>
                )}

                {/* Previously Played */}
                {previousTracks.length > 0 && (
                    <section className="border-t border-line pt-6">
                        <h2 className="mb-4 text-2xl font-black tracking-[-0.03em] text-content">
                            {queueRu.previouslyPlayed} ({previousTracks.length})
                        </h2>
                        <div className="overflow-hidden border-y border-line">
                            <Virtuoso
                                totalCount={previousTracks.length}
                                initialItemCount={Math.min(
                                    previousTracks.length,
                                    INITIAL_WINDOW_COUNT,
                                )}
                                computeItemKey={(idx) =>
                                    `prev-${previousTracks[idx]?.id ?? idx}-${idx}`
                                }
                                style={{
                                    height: Math.min(
                                        previousTracks.length * 80,
                                        600,
                                    ),
                                }}
                                itemContent={(idx) => {
                                    const item = previousTracks[idx];
                                    if (isEpisodeQueueItem(item)) {
                                        return (
                                            <EpisodeQueueRow
                                                episode={item}
                                                played
                                            />
                                        );
                                    }
                                    return (
                                        <PreviousTrackRow
                                            track={item}
                                            idx={idx}
                                            isInGroup={isInGroup}
                                            resolveQueueSource={
                                                resolveQueueSource
                                            }
                                            trackAvailability={
                                                trackAvailability
                                            }
                                        />
                                    );
                                }}
                            />
                        </div>
                    </section>
                )}
            </div>

            {/* Save as Playlist Dialog */}
            {showSaveDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <button
                        type="button"
                        aria-label="Закрыть диалог сохранения плейлиста"
                        className="absolute inset-0 cursor-default bg-black/75"
                        onClick={() => setShowSaveDialog(false)}
                    />
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="queue-save-dialog-title"
                        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-line bg-surface-overlay shadow-2xl"
                    >
                        <div className="p-6">
                            <h2
                                id="queue-save-dialog-title"
                                className="mb-1 text-lg font-bold text-content"
                            >
                                {queueRu.saveDialogTitle}
                            </h2>
                            <p className="mb-4 text-sm text-content-muted">
                                {formatQueueSaveDescription(
                                    playlistTracks.length,
                                )}
                            </p>
                            <input
                                type="text"
                                value={playlistName}
                                onChange={(e) =>
                                    setPlaylistName(e.target.value)
                                }
                                onKeyDown={(e) =>
                                    e.key === "Enter" && handleSaveAsPlaylist()
                                }
                                placeholder={`${queueRu.title} — ${new Date().toLocaleDateString("ru-RU")}`}
                                className="min-h-11 w-full rounded-xl border border-line bg-surface-elevated px-4 py-2.5 text-content outline-none transition-colors placeholder:text-content-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20"
                                autoFocus
                            />
                        </div>
                        <div className="flex gap-3 p-6 pt-0">
                            <button
                                onClick={() => setShowSaveDialog(false)}
                                className="min-h-11 flex-1 rounded-xl border border-line bg-surface-elevated px-4 py-2.5 font-medium text-content transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                            >
                                {queueRu.cancel}
                            </button>
                            <button
                                onClick={handleSaveAsPlaylist}
                                disabled={isSaving}
                                className="min-h-11 flex-1 rounded-xl bg-brand px-4 py-2.5 font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-50"
                            >
                                {isSaving ? queueRu.saving : queueRu.save}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/** Queue row for a podcast episode entry (Next Up / Previously Played). */
function EpisodeQueueRow({
    episode,
    played = false,
    onPlay,
    onRemove,
    dragHandleProps,
}: {
    episode: EpisodeQueueItem;
    played?: boolean;
    onPlay?: () => void;
    onRemove?: () => void;
    dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & {
        draggable?: boolean;
    };
}) {
    return (
        <div
            className={`group flex flex-wrap items-center gap-3 border-b border-line px-3 py-3 transition-colors hover:bg-surface-elevated/70 motion-reduce:transition-none sm:gap-4 sm:px-4 ${played ? "opacity-50" : ""}`}
        >
            {dragHandleProps && (
                <button
                    {...dragHandleProps}
                    className="hidden h-11 w-11 cursor-grab items-center justify-center rounded-xl text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light active:cursor-grabbing motion-reduce:transition-none sm:flex"
                    title={queueRu.dragToReorder}
                    aria-label={queueRu.dragToReorder}
                >
                    <GripVertical className="w-5 h-5" />
                </button>
            )}
            <div className="relative flex-shrink-0 w-12 h-12">
                {episode.coverUrl ? (
                    <Image
                        src={episode.coverUrl}
                        alt={episode.podcastTitle}
                        fill
                        sizes="48px"
                        className="object-cover rounded-sm"
                        unoptimized
                    />
                ) : (
                    <div className="w-12 h-12 bg-surface rounded-sm flex items-center justify-center">
                        <Music className="h-5 w-5 text-content-muted" />
                    </div>
                )}
            </div>
            <div className="flex-1 min-w-0">
                <h3 className="truncate text-sm font-medium text-content">
                    {episode.title}
                </h3>
                <p className="truncate text-sm text-content-muted">
                    {episode.podcastTitle}
                </p>
                <p className="truncate text-[11px] text-content-muted">
                    {queueRu.podcastEpisode}
                </p>
            </div>
            {(onPlay || onRemove) && (
                <div className="ml-auto flex items-center gap-1">
                    {onPlay && (
                        <button
                            onClick={onPlay}
                            className="flex h-11 w-11 items-center justify-center rounded-xl text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                            title={queueRu.playNow}
                            aria-label={queueRu.playNow}
                        >
                            <Play className="w-4 h-4" />
                        </button>
                    )}
                    {onRemove && (
                        <button
                            onClick={onRemove}
                            className="flex h-11 w-11 items-center justify-center rounded-xl text-error transition-colors hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error motion-reduce:transition-none"
                            title={queueRu.removeFromQueue}
                            aria-label={queueRu.removeFromQueue}
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
            )}
            <span className="hidden w-10 text-right text-xs tabular-nums text-content-muted sm:block">
                {formatTime(episode.duration)}
            </span>
        </div>
    );
}

/** Virtualized row for the "Next Up" section. */
function NextTrackRow({
    track,
    queueIndex,
    queueLength,
    currentIndex,
    isInGroup,
    resolveQueueSource,
    onMoveUp,
    onMoveDown,
    onPlay,
    onRemove,
    trackAvailability,
    dragHandleProps,
}: {
    track: Track;
    queueIndex: number;
    queueLength: number;
    currentIndex: number;
    isInGroup: boolean;
    resolveQueueSource: (
        index: number,
        fallback?: "peer" | "tidal" | "youtube" | "youtube-direct",
    ) => "local" | "peer" | "tidal" | "youtube";
    onMoveUp: (index: number) => void;
    onMoveDown: (index: number) => void;
    onPlay: (index: number) => void;
    onRemove: (index: number) => void;
    trackAvailability: Map<number, AvailabilityItem>;
    dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & {
        draggable?: boolean;
    };
}) {
    const availability = isInGroup
        ? trackAvailability.get(queueIndex)
        : undefined;
    const isUnavailable =
        availability?.available === false ||
        (track.source === "federated" && track.peer?.online === false);
    const resolvedSource = resolveQueueSource(queueIndex, track.streamSource);

    return (
        <div
            className={`group flex flex-wrap items-center gap-3 border-b border-line px-3 py-3 transition-colors hover:bg-surface-elevated/70 motion-reduce:transition-none sm:gap-4 sm:px-4 ${isUnavailable ? "opacity-50" : ""}`}
        >
            {!isInGroup && dragHandleProps && (
                <button
                    {...dragHandleProps}
                    className="hidden h-11 w-11 cursor-grab items-center justify-center rounded-xl text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light active:cursor-grabbing motion-reduce:transition-none sm:flex"
                    title={queueRu.dragToReorder}
                    aria-label={queueRu.dragToReorder}
                >
                    <GripVertical className="w-5 h-5" />
                </button>
            )}
            <div className="relative flex-shrink-0 w-12 h-12">
                {track.album?.coverArt ? (
                    <Image
                        src={api.getCoverArtUrl(track.album.coverArt, 100)}
                        alt={track.album.title}
                        fill
                        sizes="48px"
                        className="object-cover rounded-sm"
                        unoptimized
                    />
                ) : (
                    <div className="w-12 h-12 bg-surface rounded-sm flex items-center justify-center">
                        <Music className="h-5 w-5 text-content-muted" />
                    </div>
                )}
            </div>
            <div className="flex-1 min-w-0">
                <h3 className="truncate text-sm font-medium text-content">
                    {track.displayTitle ?? track.title}
                </h3>
                <p className="truncate text-sm text-content-muted">
                    {track.artist?.name}
                </p>
                <div className="mt-1 flex items-center gap-2">
                    {isUnavailable ? (
                        <span className="rounded border border-line-strong px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-content-muted">
                            {queueRu.unavailable}
                        </span>
                    ) : null}
                    {isInGroup && resolvedSource === "tidal" ? (
                        <TidalBadge />
                    ) : null}
                    {isInGroup && resolvedSource === "youtube" ? (
                        <YouTubeBadge />
                    ) : null}
                    {track.source === "federated" && track.peer ? (
                        <PeerBadge
                            peerName={track.peer.name}
                            online={track.peer.online}
                        />
                    ) : null}
                </div>
                {track.album?.title && (
                    <p className="truncate text-[11px] text-content-muted">
                        {track.album.title}
                    </p>
                )}
            </div>
            <div
                data-queue-row-actions="responsive"
                className="order-last flex basis-full items-center justify-end gap-1 sm:order-none sm:ml-auto sm:basis-auto"
            >
                {!isInGroup && (
                    <>
                        <button
                            onClick={() => onMoveUp(queueIndex)}
                            disabled={queueIndex <= currentIndex + 1}
                            className="flex h-11 w-11 items-center justify-center rounded-xl text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none"
                            title={queueRu.moveUp}
                            aria-label={queueRu.moveUp}
                        >
                            <ChevronUp className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => onMoveDown(queueIndex)}
                            disabled={queueIndex >= queueLength - 1}
                            className="flex h-11 w-11 items-center justify-center rounded-xl text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none"
                            title={queueRu.moveDown}
                            aria-label={queueRu.moveDown}
                        >
                            <ChevronDown className="w-4 h-4" />
                        </button>
                    </>
                )}
                <button
                    onClick={() => onPlay(queueIndex)}
                    disabled={isUnavailable}
                    className="flex h-11 w-11 items-center justify-center rounded-xl text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
                    title={queueRu.playNow}
                    aria-label={queueRu.playNow}
                >
                    <Play className="w-4 h-4" />
                </button>
            </div>
            <div className="flex items-center gap-1">
                <span className="hidden w-10 text-right text-xs tabular-nums text-content-muted md:block">
                    {formatTime(track.duration)}
                </span>
                <TrackPreferenceButtons
                    trackId={track.id}
                    mode="up-only"
                    buttonSizeClassName="h-11 w-11"
                    iconSizeClassName="h-4 w-4"
                    metadata={buildPreferenceMetadata(track)}
                />
                <TrackOverflowMenu
                    track={track}
                    triggerClassName="h-11 w-11 p-0"
                    showPlayNext={false}
                    showAddToQueue={false}
                    extraItemsAfter={
                        <TrackMenuButton
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove(queueIndex);
                            }}
                            icon={<X className="h-4 w-4" />}
                            label={queueRu.removeFromQueue}
                            className="text-error hover:text-error/80"
                        />
                    }
                />
            </div>
        </div>
    );
}

/** Virtualized row for the "Previously Played" section. */
function PreviousTrackRow({
    track,
    idx,
    isInGroup,
    resolveQueueSource,
    trackAvailability,
}: {
    track: Track;
    idx: number;
    isInGroup: boolean;
    resolveQueueSource: (
        index: number,
        fallback?: "peer" | "tidal" | "youtube" | "youtube-direct",
    ) => "local" | "peer" | "tidal" | "youtube";
    trackAvailability: Map<number, AvailabilityItem>;
}) {
    const availability = isInGroup ? trackAvailability.get(idx) : undefined;
    const isUnavailable =
        availability?.available === false ||
        (track.source === "federated" && track.peer?.online === false);
    const resolvedSource = resolveQueueSource(idx, track.streamSource);

    return (
        <div
            className={`group flex flex-wrap items-center gap-3 border-b border-line px-3 py-3 opacity-50 transition-colors hover:bg-surface-elevated/70 motion-reduce:transition-none sm:gap-4 sm:px-4 ${isUnavailable ? "opacity-30" : ""}`}
        >
            <div className="relative flex-shrink-0 w-12 h-12">
                {track.album?.coverArt ? (
                    <Image
                        src={api.getCoverArtUrl(track.album.coverArt, 100)}
                        alt={track.album.title}
                        fill
                        sizes="48px"
                        className="object-cover rounded-sm"
                        unoptimized
                    />
                ) : (
                    <div className="w-12 h-12 bg-surface rounded-sm flex items-center justify-center">
                        <Music className="h-5 w-5 text-content-muted" />
                    </div>
                )}
            </div>
            <div className="flex-1 min-w-0">
                <h3 className="truncate text-sm font-medium text-content">
                    {track.title}
                </h3>
                <p className="truncate text-sm text-content-muted">
                    {track.artist?.name}
                </p>
                <div className="mt-1 flex items-center gap-2">
                    {isUnavailable ? (
                        <span className="rounded border border-line-strong px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-content-muted">
                            {queueRu.unavailable}
                        </span>
                    ) : null}
                    {isInGroup && resolvedSource === "tidal" ? (
                        <TidalBadge />
                    ) : null}
                    {isInGroup && resolvedSource === "youtube" ? (
                        <YouTubeBadge />
                    ) : null}
                    {track.source === "federated" && track.peer ? (
                        <PeerBadge
                            peerName={track.peer.name}
                            online={track.peer.online}
                        />
                    ) : null}
                </div>
                {track.album?.title && (
                    <p className="truncate text-[11px] text-content-muted">
                        {track.album.title}
                    </p>
                )}
            </div>
            <div className="ml-auto flex items-center gap-1">
                <span className="hidden w-10 text-right text-xs tabular-nums text-content-muted sm:block">
                    {formatTime(track.duration)}
                </span>
                <TrackPreferenceButtons
                    trackId={track.id}
                    mode="up-only"
                    buttonSizeClassName="h-11 w-11"
                    iconSizeClassName="h-4 w-4"
                    metadata={buildPreferenceMetadata(track)}
                />
                <TrackOverflowMenu
                    track={track}
                    triggerClassName="h-11 w-11 p-0"
                    showPlayNext={false}
                    showAddToQueue={false}
                />
            </div>
        </div>
    );
}
