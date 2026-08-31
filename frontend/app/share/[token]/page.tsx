"use client";

import {
    AlertCircle,
    Download,
    FileJson,
    FileText,
    ListMusic,
    Music,
    Pause,
    Play,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
} from "lucide-react";
import { useParams } from "next/navigation";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { api } from "@/lib/api";
import {
    MusicDetailActionDock,
    MusicDetailHero,
    MusicDetailTrackSurface,
} from "@/components/music-detail";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import {
    formatShareCount,
    formatShareOwner,
    shareRu,
} from "@/lib/i18n/utilityPagesRu";

interface AlbumTrackResource {
    id: string;
    title: string;
    duration: number;
    trackNo: number;
    discNo: number;
    album: {
        title: string;
        artist: {
            id: string;
            name: string;
        };
    };
}

interface AlbumResource {
    id: string;
    title: string;
    coverArt?: string | null;
    coverUrl?: string | null;
    artist: {
        id: string;
        name: string;
        mbid?: string;
    };
    tracks: AlbumTrackResource[];
}

interface TrackResource {
    id: string;
    title: string;
    duration: number;
    album: {
        id: string;
        title: string;
        coverArt?: string | null;
        coverUrl?: string | null;
        artist: {
            id: string;
            name: string;
        };
    };
}

interface PlaylistItemResource {
    id: string;
    sort: number;
    track: {
        id: string;
        title: string;
        duration: number;
        album: {
            title: string;
            coverArt?: string | null;
            coverUrl?: string | null;
            artist: {
                id: string;
                name: string;
            };
        };
    } | null;
}

interface PlaylistResource {
    id: string;
    name: string;
    user?: {
        username: string;
    };
    items: PlaylistItemResource[];
}

interface ShareResponse {
    resourceType: "album" | "track" | "playlist";
    resource: AlbumResource | TrackResource | PlaylistResource;
}

interface PlayableTrack {
    id: string;
    title: string;
    artist: string;
    coverUrl: string | null;
    duration: number;
}

function buildJsonExport(name: string, tracks: PlayableTrack[]): string {
    return JSON.stringify(
        {
            name,
            exportedAt: new Date().toISOString(),
            source: "soundspan",
            tracks: tracks.map((track) => ({
                title: track.title,
                artist: track.artist,
                duration: track.duration,
            })),
        },
        null,
        2,
    );
}

function buildM3uExport(name: string, tracks: PlayableTrack[]): string {
    const lines = ["#EXTM3U", `#PLAYLIST:${name}`];
    for (const track of tracks) {
        lines.push(
            `#EXTINF:${Math.round(track.duration)},${track.artist} - ${track.title}`,
        );
        lines.push(track.title);
    }
    return lines.join("\n");
}

function downloadBlob(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
}

function sanitizeFilename(value: string): string {
    return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "playlist";
}

function buildPlayableTrackQueue(
    data: ShareResponse,
    getCoverUrl: (rawUrl: string | null | undefined) => string | null,
): PlayableTrack[] {
    if (data.resourceType === "album") {
        const album = data.resource as AlbumResource;
        const coverUrl = getCoverUrl(album.coverUrl || album.coverArt);
        return album.tracks.map((track) => ({
            id: track.id,
            title: track.title,
            artist: album.artist.name,
            coverUrl,
            duration: track.duration,
        }));
    }

    if (data.resourceType === "playlist") {
        const playlist = data.resource as PlaylistResource;
        return [...playlist.items]
            .sort((a, b) => a.sort - b.sort)
            .filter(
                (
                    item,
                ): item is PlaylistItemResource & {
                    track: NonNullable<PlaylistItemResource["track"]>;
                } => item.track !== null,
            )
            .map((item) => ({
                id: item.track.id,
                title: item.track.title,
                artist: item.track.album.artist.name,
                coverUrl: getCoverUrl(
                    item.track.album.coverUrl || item.track.album.coverArt,
                ),
                duration: item.track.duration,
            }));
    }

    const track = data.resource as TrackResource;
    return [
        {
            id: track.id,
            title: track.title,
            artist: track.album.artist.name,
            coverUrl: getCoverUrl(track.album.coverUrl || track.album.coverArt),
            duration: track.duration,
        },
    ];
}

/** Renders the SharePage component. */
export default function SharePage() {
    const params = useParams<{ token: string | string[] }>();
    const token = Array.isArray(params.token) ? params.token[0] : params.token;

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [data, setData] = useState<ShareResponse | null>(null);

    const [currentTrack, setCurrentTrack] = useState<PlayableTrack | null>(
        null,
    );
    const [isPlaying, setIsPlaying] = useState(false);
    const [progress, setProgress] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const audioRef = useRef<HTMLAudioElement>(null);

    const getCoverUrl = useCallback(
        (rawUrl: string | null | undefined): string | null => {
            if (!token || !rawUrl) {
                return null;
            }
            return `/api/share-links/access/${token}/cover?url=${encodeURIComponent(rawUrl)}`;
        },
        [token],
    );

    const getStreamUrl = useCallback(
        (trackId: string): string =>
            `/api/share-links/access/${token}/stream/${trackId}`,
        [token],
    );

    const getDownloadUrl = useCallback(
        (trackId: string): string =>
            `/api/share-links/access/${token}/stream/${trackId}?download=true`,
        [token],
    );

    const getZipUrl = useCallback(
        (): string => `/api/share-links/access/${token}/zip`,
        [token],
    );

    const trackQueue = useMemo(
        () => (data ? buildPlayableTrackQueue(data, getCoverUrl) : []),
        [data, getCoverUrl],
    );

    const currentTrackIndex = useMemo(
        () => trackQueue.findIndex((track) => track.id === currentTrack?.id),
        [trackQueue, currentTrack],
    );

    const hasPrev = currentTrackIndex > 0;
    const hasNext =
        currentTrackIndex >= 0 && currentTrackIndex < trackQueue.length - 1;

    const playTrack = useCallback(
        (track: PlayableTrack) => {
            const audio = audioRef.current;
            if (!audio) {
                return;
            }

            if (currentTrack?.id === track.id) {
                if (audio.paused) {
                    void audio.play().catch(() => undefined);
                } else {
                    audio.pause();
                }
                return;
            }

            setCurrentTrack(track);
            setProgress(0);
            setDuration(track.duration);
        },
        [currentTrack],
    );

    const handlePlayPause = useCallback(() => {
        const audio = audioRef.current;
        if (!audio || !currentTrack) {
            return;
        }

        if (audio.paused) {
            void audio.play().catch(() => undefined);
        } else {
            audio.pause();
        }
    }, [currentTrack]);

    const handleNext = useCallback(() => {
        if (!hasNext || currentTrackIndex < 0) {
            setIsPlaying(false);
            return;
        }
        const nextTrack = trackQueue[currentTrackIndex + 1];
        if (nextTrack) {
            setCurrentTrack(nextTrack);
            setProgress(0);
            setDuration(nextTrack.duration);
        }
    }, [currentTrackIndex, hasNext, trackQueue]);

    const handlePrev = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) {
            return;
        }

        if (audio.currentTime > 3) {
            audio.currentTime = 0;
            setProgress(0);
            return;
        }

        if (!hasPrev || currentTrackIndex < 0) {
            return;
        }

        const prevTrack = trackQueue[currentTrackIndex - 1];
        if (prevTrack) {
            setCurrentTrack(prevTrack);
            setProgress(0);
            setDuration(prevTrack.duration);
        }
    }, [currentTrackIndex, hasPrev, trackQueue]);

    const handleVolumeChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const nextVolume = Number(event.target.value) / 100;
            setVolume(nextVolume);
            setIsMuted(nextVolume === 0);
        },
        [],
    );

    const toggleMute = useCallback(() => {
        setIsMuted((previous) => !previous);
    }, []);

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            if (!token) {
                if (!cancelled) {
                    setError(true);
                    setLoading(false);
                }
                return;
            }

            try {
                setLoading(true);
                setError(false);
                const json = (await api.getSharedResource(
                    token,
                )) as ShareResponse;
                if (!cancelled) {
                    const nextQueue = buildPlayableTrackQueue(
                        json,
                        getCoverUrl,
                    );
                    const firstTrack = nextQueue[0] ?? null;
                    setData(json);
                    setCurrentTrack(firstTrack);
                    setIsPlaying(false);
                    setProgress(0);
                    setDuration(firstTrack?.duration ?? 0);
                }
            } catch {
                if (!cancelled) {
                    setError(true);
                    setData(null);
                    setCurrentTrack(null);
                    setIsPlaying(false);
                    setProgress(0);
                    setDuration(0);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        void load();

        return () => {
            cancelled = true;
        };
    }, [getCoverUrl, token]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || !currentTrack) {
            return;
        }
        audio.load();
        void audio.play().catch(() => undefined);
    }, [currentTrack]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) {
            return;
        }
        audio.volume = isMuted ? 0 : volume;
        audio.muted = isMuted;
    }, [isMuted, volume]);

    if (loading) {
        return <LoadingScreen message={shareRu.loading} />;
    }

    if (error || !data) {
        return (
            <main
                role="alert"
                className="flex min-h-screen items-center justify-center bg-surface px-4"
            >
                <EmptyState
                    icon={
                        <AlertCircle className="h-7 w-7" aria-hidden="true" />
                    }
                    title={shareRu.unavailableTitle}
                    description={shareRu.unavailableDescription}
                />
            </main>
        );
    }

    const albumResource =
        data.resourceType === "album" ? (data.resource as AlbumResource) : null;
    const trackResource =
        data.resourceType === "track" ? (data.resource as TrackResource) : null;
    const playlistResource =
        data.resourceType === "playlist"
            ? (data.resource as PlaylistResource)
            : null;
    const resourceTitle =
        albumResource?.title ||
        trackResource?.title ||
        playlistResource?.name ||
        "Музыка";
    const resourceSubtitle =
        albumResource?.artist.name ||
        trackResource?.album.artist.name ||
        formatShareOwner(playlistResource?.user?.username);
    const resourceCoverUrl = albumResource
        ? getCoverUrl(albumResource.coverUrl || albumResource.coverArt)
        : trackResource
          ? getCoverUrl(
                trackResource.album.coverUrl || trackResource.album.coverArt,
            )
          : (trackQueue[0]?.coverUrl ?? null);
    const resourceEyebrow =
        data.resourceType === "album"
            ? shareRu.sharedAlbum
            : data.resourceType === "track"
              ? shareRu.sharedTrack
              : shareRu.sharedPlaylist;
    const totalDuration = trackQueue.reduce(
        (sum, track) => sum + track.duration,
        0,
    );
    const progressPercent =
        duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;

    return (
        <>
            <main className="min-h-screen bg-surface pb-40 text-content">
                <MusicDetailHero
                    eyebrow={resourceEyebrow}
                    title={resourceTitle}
                    artworkShape="square"
                    backgroundImage={resourceCoverUrl}
                    description={
                        <p>
                            {data.resourceType === "playlist"
                                ? resourceSubtitle
                                : data.resourceType === "track"
                                  ? trackResource?.album.title
                                  : "Открытая ссылка Soundspan"}
                        </p>
                    }
                    metadata={
                        <>
                            <span>
                                {formatShareCount(
                                    trackQueue.length,
                                    data.resourceType === "playlist"
                                        ? "playlist"
                                        : "tracks",
                                )}
                            </span>
                            {totalDuration > 0 && (
                                <>
                                    <span aria-hidden="true">•</span>
                                    <span>{formatTime(totalDuration)}</span>
                                </>
                            )}
                        </>
                    }
                    artwork={
                        resourceCoverUrl ? (
                            <Image
                                src={resourceCoverUrl}
                                alt={shareRu.coverAlt}
                                fill
                                sizes="(max-width: 640px) 176px, 224px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand/20 via-ai/10 to-surface-highlight">
                                <Music
                                    className="h-16 w-16 text-content-muted"
                                    aria-hidden="true"
                                />
                            </div>
                        )
                    }
                    actions={
                        <MusicDetailActionDock
                            label={resourceTitle + ": действия"}
                        >
                            <div
                                data-detail-action-tier="primary"
                                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
                            >
                                <button
                                    type="button"
                                    onClick={handlePrev}
                                    disabled={!hasPrev && progress <= 3}
                                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
                                    aria-label={shareRu.previous}
                                    title={shareRu.previous}
                                >
                                    <SkipBack className="h-5 w-5" />
                                </button>
                                <button
                                    type="button"
                                    onClick={handlePlayPause}
                                    disabled={!currentTrack}
                                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-brand-hover px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:flex-none"
                                    aria-label={
                                        isPlaying ? shareRu.pause : shareRu.play
                                    }
                                >
                                    {isPlaying ? (
                                        <Pause className="h-5 w-5 fill-current" />
                                    ) : (
                                        <Play className="ml-0.5 h-5 w-5 fill-current" />
                                    )}
                                    <span>
                                        {isPlaying
                                            ? shareRu.pause
                                            : shareRu.play}
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={handleNext}
                                    disabled={!hasNext}
                                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
                                    aria-label={shareRu.next}
                                    title={shareRu.next}
                                >
                                    <SkipForward className="h-5 w-5" />
                                </button>
                            </div>

                            <div
                                data-detail-action-tier="secondary"
                                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
                            >
                                {(data.resourceType === "album" ||
                                    data.resourceType === "playlist") && (
                                    <a
                                        href={getZipUrl()}
                                        download="soundspan-share.zip"
                                        className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    >
                                        <Download className="h-4 w-4" />
                                        <span>{shareRu.downloadAll}</span>
                                    </a>
                                )}
                                {trackResource && (
                                    <a
                                        href={getDownloadUrl(trackResource.id)}
                                        download
                                        className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    >
                                        <Download className="h-4 w-4" />
                                        <span>{shareRu.download}</span>
                                    </a>
                                )}
                                {playlistResource && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                downloadBlob(
                                                    buildJsonExport(
                                                        playlistResource.name,
                                                        trackQueue,
                                                    ),
                                                    sanitizeFilename(
                                                        playlistResource.name,
                                                    ) + ".json",
                                                    "application/json",
                                                )
                                            }
                                            className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                        >
                                            <FileJson className="h-4 w-4" />
                                            <span>JSON</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                downloadBlob(
                                                    buildM3uExport(
                                                        playlistResource.name,
                                                        trackQueue,
                                                    ),
                                                    sanitizeFilename(
                                                        playlistResource.name,
                                                    ) + ".m3u",
                                                    "audio/x-mpegurl",
                                                )
                                            }
                                            className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                        >
                                            <FileText className="h-4 w-4" />
                                            <span>M3U</span>
                                        </button>
                                    </>
                                )}
                            </div>
                        </MusicDetailActionDock>
                    }
                />

                <section className="mx-auto max-w-[1800px] px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
                    {trackQueue.length > 0 ? (
                        <MusicDetailTrackSurface
                            label={resourceTitle + ": треки"}
                        >
                            <div
                                role="list"
                                aria-label={shareRu.upNext}
                                className="divide-y divide-white/[0.06]"
                            >
                                {trackQueue.map((track, index) => {
                                    const isCurrent =
                                        currentTrack?.id === track.id;
                                    return (
                                        <div
                                            key={track.id}
                                            role="listitem"
                                            className={cn(
                                                "group flex min-w-0 items-center gap-2 rounded-[14px] px-1 py-1.5 transition-colors hover:bg-white/[0.05] motion-reduce:transition-none sm:px-2",
                                                isCurrent && "bg-brand/[0.08]",
                                            )}
                                        >
                                            <button
                                                type="button"
                                                aria-label={
                                                    "Воспроизвести «" +
                                                    track.title +
                                                    "»"
                                                }
                                                onClick={() => playTrack(track)}
                                                className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                                            >
                                                <span
                                                    className={cn(
                                                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs tabular-nums",
                                                        isCurrent
                                                            ? "bg-brand/15 text-brand-light"
                                                            : "text-content-muted",
                                                    )}
                                                >
                                                    {isCurrent && isPlaying ? (
                                                        <Pause className="h-4 w-4" />
                                                    ) : (
                                                        index + 1
                                                    )}
                                                </span>
                                                <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-surface-highlight">
                                                    {track.coverUrl ? (
                                                        <Image
                                                            src={track.coverUrl}
                                                            alt=""
                                                            fill
                                                            sizes="44px"
                                                            className="object-cover"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <span className="flex h-full w-full items-center justify-center">
                                                            <Music className="h-4 w-4 text-content-muted" />
                                                        </span>
                                                    )}
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span
                                                        className={cn(
                                                            "block truncate text-sm font-medium",
                                                            isCurrent
                                                                ? "text-brand-light"
                                                                : "text-content",
                                                        )}
                                                    >
                                                        {track.title}
                                                    </span>
                                                    <span className="block truncate text-xs text-content-muted">
                                                        {track.artist}
                                                    </span>
                                                </span>
                                                <span className="hidden shrink-0 text-xs tabular-nums text-content-muted sm:inline">
                                                    {formatTime(track.duration)}
                                                </span>
                                            </button>
                                            <a
                                                href={getDownloadUrl(track.id)}
                                                download
                                                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-content-muted transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                                onClick={(event) =>
                                                    event.stopPropagation()
                                                }
                                                title={shareRu.downloadTrack}
                                                aria-label={
                                                    shareRu.downloadTrack +
                                                    ": " +
                                                    track.title
                                                }
                                            >
                                                <Download className="h-4 w-4" />
                                            </a>
                                        </div>
                                    );
                                })}
                            </div>
                        </MusicDetailTrackSurface>
                    ) : (
                        <EmptyState
                            icon={
                                <ListMusic
                                    className="h-7 w-7"
                                    aria-hidden="true"
                                />
                            }
                            title="В общей ссылке нет треков"
                            description="Владелец пока не добавил доступную музыку."
                        />
                    )}
                    <p className="pt-8 text-center text-xs text-content-muted">
                        soundspan™
                    </p>
                </section>
            </main>

            {currentTrack ? (
                <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/[0.08] bg-black/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
                    <div className="absolute inset-x-0 top-0 h-1 bg-white/15">
                        <div
                            className="h-full bg-brand-light transition-none"
                            style={{ width: progressPercent + "%" }}
                        />
                        <input
                            type="range"
                            min={0}
                            max={
                                Math.max(duration, currentTrack.duration) || 100
                            }
                            step={0.1}
                            value={progress}
                            onChange={(event) => {
                                const audio = audioRef.current;
                                if (!audio) return;
                                const seekTime = Number(event.target.value);
                                audio.currentTime = seekTime;
                                setProgress(seekTime);
                            }}
                            aria-label={shareRu.playbackProgress}
                            className="absolute -top-5 h-11 w-full cursor-pointer opacity-0"
                        />
                    </div>

                    <div className="flex h-20 items-center justify-center gap-2 px-3 pt-1 sm:grid sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:px-5">
                        <div className="hidden min-w-0 items-center gap-3 sm:flex">
                            <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface-highlight">
                                {currentTrack.coverUrl ? (
                                    <Image
                                        src={currentTrack.coverUrl}
                                        alt=""
                                        fill
                                        sizes="48px"
                                        className="object-cover"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="flex h-full w-full items-center justify-center">
                                        <Music className="h-5 w-5 text-content-muted" />
                                    </div>
                                )}
                            </div>
                            <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-content">
                                    {currentTrack.title}
                                </p>
                                <p className="truncate text-xs text-content-muted">
                                    {currentTrack.artist}
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center justify-center gap-1 sm:gap-2">
                            <button
                                type="button"
                                onClick={handlePrev}
                                disabled={!hasPrev && progress <= 3}
                                className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none"
                                title={shareRu.previous}
                                aria-label={shareRu.previous}
                            >
                                <SkipBack className="h-5 w-5" />
                            </button>
                            <button
                                type="button"
                                onClick={handlePlayPause}
                                className="flex h-12 w-12 items-center justify-center rounded-full bg-content text-black shadow-lg transition-transform hover:scale-[1.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                title={isPlaying ? shareRu.pause : shareRu.play}
                                aria-label={
                                    isPlaying ? shareRu.pause : shareRu.play
                                }
                            >
                                {isPlaying ? (
                                    <Pause className="h-5 w-5 fill-current" />
                                ) : (
                                    <Play className="ml-0.5 h-5 w-5 fill-current" />
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={handleNext}
                                disabled={!hasNext}
                                className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none"
                                title={shareRu.next}
                                aria-label={shareRu.next}
                            >
                                <SkipForward className="h-5 w-5" />
                            </button>
                            <div className="group/volume relative flex items-center justify-center">
                                <button
                                    type="button"
                                    onClick={toggleMute}
                                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    aria-label={
                                        isMuted || volume === 0
                                            ? shareRu.unmute
                                            : shareRu.mute
                                    }
                                    title={
                                        isMuted || volume === 0
                                            ? shareRu.unmute
                                            : shareRu.mute
                                    }
                                >
                                    {isMuted || volume === 0 ? (
                                        <VolumeX className="h-5 w-5" />
                                    ) : (
                                        <Volume2 className="h-5 w-5" />
                                    )}
                                </button>
                                <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 scale-95 rounded-xl border border-white/10 bg-surface-raised p-3 opacity-0 shadow-xl transition-all group-hover/volume:pointer-events-auto group-hover/volume:scale-100 group-hover/volume:opacity-100 group-focus-within/volume:pointer-events-auto group-focus-within/volume:scale-100 group-focus-within/volume:opacity-100 motion-reduce:transition-none">
                                    <input
                                        type="range"
                                        min="0"
                                        max="100"
                                        value={
                                            isMuted
                                                ? 0
                                                : Math.round(volume * 100)
                                        }
                                        onChange={handleVolumeChange}
                                        aria-label={shareRu.volume}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={Math.round(volume * 100)}
                                        className="h-11 w-28 cursor-pointer accent-brand"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="hidden justify-end text-sm tabular-nums text-content-muted sm:flex">
                            {formatTime(progress)}
                            {" / "}
                            {formatTime(duration || currentTrack.duration)}
                        </div>
                    </div>
                </div>
            ) : null}

            <audio
                ref={audioRef}
                src={currentTrack ? getStreamUrl(currentTrack.id) : undefined}
                onTimeUpdate={() =>
                    setProgress(audioRef.current?.currentTime ?? 0)
                }
                onLoadedMetadata={() =>
                    setDuration(audioRef.current?.duration ?? 0)
                }
                onEnded={handleNext}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
            >
                <track kind="captions" srcLang="en" label="Музыка" />
            </audio>
        </>
    );
}
