"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Heart, ListMusic, Network, Play } from "lucide-react";
import { api } from "@/lib/api";
import type { PeerPlaylistTrack } from "@/lib/api/peerPlaylists";
import { useAudioControls } from "@/lib/audio-context";
import type { Track as AudioTrack } from "@/lib/audio-state-context";
import { useToast } from "@/lib/toast-context";
import {
    MusicDetailActionDock,
    MusicDetailHero,
    MusicDetailTrackSurface,
} from "@/components/music-detail";
import { TrackList } from "@/components/track";
import type { TrackRowItem, TrackRowSlots } from "@/components/track";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import {
    useFollowedPeerPlaylists,
    usePeerPlaylist,
} from "@/features/social/hooks/usePeerPlaylists";
import { queryKeys } from "@/lib/queryKeys";

/** Maps a resolved peer playlist row onto the audio-context track shape. */
function peerRowToAudioTrack(row: PeerPlaylistTrack): AudioTrack | null {
    const track = row.track;
    if (!row.isResolvable || !track) return null;
    return {
        id: track.id,
        title: track.title,
        artist: {
            name: track.album.artist.name,
            id: track.album.artist.id,
        },
        album: {
            title: track.album.title,
            coverArt: track.album.coverArt || undefined,
            id: track.album.id,
        },
        duration: track.duration,
        source: track.source,
        peer: track.peer,
        ...(track.streamSource
            ? {
                  streamSource: track.streamSource,
                  tidalTrackId: track.tidalTrackId,
                  youtubeVideoId: track.youtubeVideoId,
              }
            : {}),
    };
}

function peerRowOfflineIdentity(
    row: PeerPlaylistTrack,
): Pick<
    TrackRowItem,
    "id" | "streamSource" | "tidalTrackId" | "youtubeVideoId"
> | null {
    const resolvedTrack = row.isResolvable ? row.track : null;
    if (!resolvedTrack) return null;
    if (resolvedTrack.streamSource === "tidal") {
        return {
            id: resolvedTrack.id,
            streamSource: "tidal",
            tidalTrackId: resolvedTrack.tidalTrackId,
        };
    }
    if (resolvedTrack.streamSource === "youtube") {
        return {
            id: resolvedTrack.id,
            streamSource: "youtube",
            youtubeVideoId: resolvedTrack.youtubeVideoId,
        };
    }
    if (row.resolution === "local") {
        return { id: resolvedTrack.id, streamSource: "local" };
    }
    return null;
}

function peerRowToTrackItem(row: PeerPlaylistTrack): TrackRowItem {
    const offlineIdentity = peerRowOfflineIdentity(row);
    return {
        id: offlineIdentity?.id ?? row.remoteTrackId,
        title: row.title,
        artistName: row.artist,
        duration: row.duration,
        streamSource: offlineIdentity?.streamSource,
        tidalTrackId: offlineIdentity?.tidalTrackId,
        youtubeVideoId: offlineIdentity?.youtubeVideoId,
        coverArtUrl: null,
        isPlayable: Boolean(peerRowToAudioTrack(row)),
    };
}

function peerRowSlots(row: PeerPlaylistTrack): TrackRowSlots {
    const isPlayable = Boolean(peerRowToAudioTrack(row));
    return {
        middleColumns: (
            <p className="text-content-muted hidden items-center truncate text-sm md:flex">
                {row.album}
            </p>
        ),
        subtitleExtra: !isPlayable ? (
            <span className="text-xs text-content-muted">
                Недоступно на этом сервере
            </span>
        ) : null,
        rowClassName: !isPlayable ? "opacity-45" : undefined,
    };
}

/** Public playlist shared by another Soundspan server. */
export default function PeerPlaylistDetailPage() {
    const params = useParams<{ peerId: string; remoteId: string }>();
    const peerId = params.peerId;
    const remoteId = params.remoteId;
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const { playNow, playTracks } = useAudioControls();
    const [busy, setBusy] = useState(false);

    const detailQuery = usePeerPlaylist(peerId, remoteId);
    const followedQuery = useFollowedPeerPlaylists();
    const detail = detailQuery.data;
    const rows = useMemo(
        () => detail?.playlist.tracks ?? [],
        [detail?.playlist.tracks],
    );
    const playable = useMemo(
        () =>
            rows
                .map(peerRowToAudioTrack)
                .filter((track): track is AudioTrack => track !== null),
        [rows],
    );
    const followState: "loading" | "unknown" | "followed" | "not-followed" =
        followedQuery.isLoading
            ? "loading"
            : followedQuery.isError
              ? "unknown"
              : followedQuery.data?.playlists.some(
                      (playlist) =>
                          playlist.peerId === peerId &&
                          playlist.remoteId === remoteId,
                  )
                ? "followed"
                : "not-followed";
    const isFollowed = followState === "followed";

    const invalidate = () =>
        queryClient.invalidateQueries({
            queryKey: queryKeys.peerPlaylistsAll(),
        });

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try {
            await action();
        } catch {
            toast.error(
                "Не удалось подключиться к удалённому серверу. Попробуйте позже.",
            );
        } finally {
            setBusy(false);
        }
    };

    if (detailQuery.isLoading) {
        return <LoadingScreen message="Загружаем общий плейлист…" />;
    }

    if (!detail) {
        return (
            <main
                role="alert"
                className="flex min-h-screen items-center justify-center bg-surface px-4"
            >
                <EmptyState
                    icon={<Network className="h-7 w-7" aria-hidden="true" />}
                    title="Плейлист сейчас недоступен"
                    description="Удалённый сервер может быть не в сети, либо владелец закрыл доступ. Попробуйте позже."
                />
            </main>
        );
    }

    const playlist = detail.playlist;
    return (
        <div className="min-h-screen bg-surface">
            <MusicDetailHero
                eyebrow="Общий плейлист"
                title={playlist.name}
                artworkShape="square"
                artwork={
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-ai/25 via-brand/10 to-surface-highlight">
                        <ListMusic
                            className="h-16 w-16 text-content-secondary"
                            aria-hidden="true"
                        />
                    </div>
                }
                metadata={
                    <>
                        <span>{playlist.owner.displayName}</span>
                        <span aria-hidden="true">•</span>
                        <span>{detail.peer.name}</span>
                        <span aria-hidden="true">•</span>
                        <span>
                            Доступно {playable.length} из {rows.length}
                        </span>
                    </>
                }
                description={
                    <p>
                        Подборка синхронизируется с сервером владельца;
                        доступные треки можно слушать сразу.
                    </p>
                }
                actions={
                    <MusicDetailActionDock label={`${playlist.name}: действия`}>
                        <div
                            data-detail-action-tier="primary"
                            className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
                        >
                            <button
                                type="button"
                                disabled={busy || playable.length === 0}
                                onClick={() => {
                                    playTracks(playable, 0);
                                    toast.success(
                                        "Воспроизводится удалённый плейлист",
                                    );
                                }}
                                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-brand-hover px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:flex-none"
                            >
                                <Play className="h-5 w-5 fill-current" />
                                <span>Слушать</span>
                            </button>
                        </div>

                        <div
                            data-detail-action-tier="secondary"
                            className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
                        >
                            <button
                                type="button"
                                disabled={
                                    busy ||
                                    followState === "loading" ||
                                    followState === "unknown"
                                }
                                onClick={() =>
                                    void run(async () => {
                                        if (isFollowed) {
                                            await api.unfollowPeerPlaylist(
                                                peerId,
                                                remoteId,
                                            );
                                            toast.success(
                                                "Плейлист больше не отслеживается",
                                            );
                                        } else {
                                            await api.followPeerPlaylist(
                                                peerId,
                                                remoteId,
                                            );
                                            toast.success(
                                                "Плейлист отслеживается и будет синхронизироваться",
                                            );
                                        }
                                        await invalidate();
                                    })
                                }
                                className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                            >
                                <Heart className="h-4 w-4" />
                                <span>
                                    {isFollowed
                                        ? "Не отслеживать"
                                        : "Отслеживать"}
                                </span>
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                    void run(async () => {
                                        const result =
                                            await api.copyPeerPlaylist(
                                                peerId,
                                                remoteId,
                                            );
                                        toast.success(
                                            `Копия сохранена: ${result.copied} треков${result.skipped ? `, пропущено ${result.skipped}` : ""}`,
                                        );
                                        await invalidate();
                                    })
                                }
                                className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                            >
                                <Copy className="h-4 w-4" />
                                <span>Сохранить копию</span>
                            </button>
                        </div>
                    </MusicDetailActionDock>
                }
            />

            <main className="mx-auto max-w-[1800px] px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
                {rows.length > 0 ? (
                    <MusicDetailTrackSurface label={`${playlist.name}: треки`}>
                        <TrackList<PeerPlaylistTrack>
                            items={rows}
                            toRowItem={peerRowToTrackItem}
                            getKey={(row, index) =>
                                `${row.remoteTrackId}:${index}`
                            }
                            onPlay={(row) => {
                                const track = peerRowToAudioTrack(row);
                                if (track) playNow(track);
                            }}
                            rowSlots={peerRowSlots}
                            showCoverArt={false}
                            preferenceMode={null}
                            accentColor="var(--music-action)"
                            rowClassName="grid-cols-[28px_minmax(0,1fr)_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto]"
                        />
                    </MusicDetailTrackSurface>
                ) : (
                    <EmptyState
                        icon={
                            <ListMusic className="h-7 w-7" aria-hidden="true" />
                        }
                        title="В плейлисте пока нет треков"
                        description="Когда владелец добавит музыку, она появится здесь после синхронизации."
                    />
                )}
            </main>
        </div>
    );
}
