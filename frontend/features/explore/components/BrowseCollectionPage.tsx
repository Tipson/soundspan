"use client";

import { Suspense } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import {
    ArrowLeft,
    Heart,
    ListMusic,
    Loader2,
    Music2,
    Pause,
    Play,
    Plus,
    Shuffle,
} from "lucide-react";
import { api } from "@/lib/api";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import {
    MusicDetailActionDock,
    MusicDetailHero,
    MusicDetailTrackSurface,
} from "@/components/music-detail";
import { cn } from "@/utils/cn";
import { decodeRouteId } from "@/utils/routeId";
import {
    BrowseTrackList,
    type TidalBrowseCollection,
} from "@/features/explore/browseTrack";
import {
    browseCollectionCopy,
    formatTotalDuration,
    type BrowseCollectionKind,
} from "@/features/explore/browseCollectionCopy";
import { useBrowseCollection } from "@/features/explore/hooks/useBrowseCollection";
import { useBrowseCollectionActions } from "@/features/explore/hooks/useBrowseCollectionActions";
import { pluralRu } from "@/lib/i18n/ru";

export type { BrowseCollectionKind } from "@/features/explore/browseCollectionCopy";

export interface BrowseCollectionPageProps {
    /** Lowercase collection noun used in user-facing copy. */
    kind: BrowseCollectionKind;
    /** Fetch the collection by its decoded route id. */
    fetchCollection: (id: string) => Promise<TidalBrowseCollection>;
}

type Copy = ReturnType<typeof browseCollectionCopy>;
type Actions = ReturnType<typeof useBrowseCollectionActions>;

/** Shared detail page for provider browse playlists and mixes. */
export function BrowseCollectionPage(props: BrowseCollectionPageProps) {
    const loadingLabel =
        props.kind === "mix" ? "Загружаем микс…" : "Загружаем плейлист…";
    return (
        <Suspense fallback={<LoadingScreen message={loadingLabel} />}>
            <BrowseCollectionPageContent {...props} />
        </Suspense>
    );
}

function BrowseCollectionPageContent({
    kind,
    fetchCollection,
}: BrowseCollectionPageProps) {
    const params = useParams();
    const router = useRouter();
    const collectionId = decodeRouteId(params.id as string);
    const copy = browseCollectionCopy(kind);
    const loadingLabel =
        kind === "mix" ? "Загружаем микс…" : "Загружаем плейлист…";

    const { collection, isLoading, error } = useBrowseCollection(
        collectionId,
        fetchCollection,
        copy.loadErrorFallback,
    );
    const actions = useBrowseCollectionActions(
        collection,
        copy.noPlayableTracks,
    );

    if (isLoading) {
        return <LoadingScreen message={loadingLabel} />;
    }

    if (error || !collection) {
        return <CollectionNotFound copy={copy} error={error} router={router} />;
    }

    const imageUrl = collection.thumbnailUrl
        ? api.getTidalBrowseImageUrl(collection.thumbnailUrl)
        : null;
    const totalDuration = collection.tracks.reduce(
        (sum, track) => sum + track.duration,
        0,
    );

    return (
        <div className="min-h-screen bg-surface">
            <MusicDetailHero
                eyebrow={copy.heroLabel}
                title={collection.title}
                artworkShape="square"
                backgroundImage={imageUrl}
                metadata={
                    <>
                        <span>
                            {collection.trackCount}{" "}
                            {pluralRu(collection.trackCount, [
                                "трек",
                                "трека",
                                "треков",
                            ])}
                        </span>
                        {totalDuration > 0 && (
                            <>
                                <span aria-hidden="true">•</span>
                                <span>
                                    {formatTotalDuration(totalDuration)}
                                </span>
                            </>
                        )}
                    </>
                }
                artwork={
                    imageUrl ? (
                        <Image
                            src={imageUrl}
                            alt={collection.title}
                            fill
                            sizes="(max-width: 640px) 176px, 224px"
                            className="object-cover"
                            priority
                            unoptimized
                        />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand/20 via-ai/10 to-surface-highlight">
                            <Music2
                                className="h-16 w-16 text-content-muted"
                                aria-hidden="true"
                            />
                        </div>
                    )
                }
                actions={
                    <CollectionActionDock
                        collection={collection}
                        actions={actions}
                        router={router}
                    />
                }
            />

            <main className="mx-auto max-w-[1800px] px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
                {collection.tracks.length > 0 ? (
                    <MusicDetailTrackSurface
                        label={`${collection.title}: треки`}
                    >
                        <BrowseTrackList
                            tracks={collection.tracks}
                            onPlayTrack={actions.handlePlayTrack}
                        />
                    </MusicDetailTrackSurface>
                ) : (
                    <EmptyTracks message={copy.emptyMessage} />
                )}
            </main>

            <PlaylistSelector
                isOpen={actions.showPlaylistSelector}
                onClose={() => actions.setShowPlaylistSelector(false)}
                onSelectPlaylist={actions.handlePlaylistSelected}
                isLoading={actions.isAddingToPlaylist}
                loadingMessage="Добавляем треки…"
            />
        </div>
    );
}

function CollectionNotFound({
    copy,
    error,
    router,
}: {
    copy: Copy;
    error: string | null;
    router: ReturnType<typeof useRouter>;
}) {
    return (
        <main
            role="alert"
            className="flex min-h-screen items-center justify-center bg-surface px-4"
        >
            <EmptyState
                icon={<Music2 className="h-7 w-7" aria-hidden="true" />}
                title={copy.notFoundTitle}
                description={error || copy.notFoundFallback}
                action={{
                    label: "Назад",
                    onClick: () => router.back(),
                    variant: "secondary",
                }}
            />
        </main>
    );
}

function CollectionActionDock({
    collection,
    actions,
    router,
}: {
    collection: TidalBrowseCollection;
    actions: Actions;
    router: ReturnType<typeof useRouter>;
}) {
    return (
        <MusicDetailActionDock label={`${collection.title}: действия`}>
            <div
                data-detail-action-tier="primary"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
            >
                <button
                    type="button"
                    onClick={actions.handleTogglePlay}
                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-brand-hover px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:flex-none"
                >
                    {actions.showPlaySpinner ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                    ) : actions.isThisCollectionPlaying && actions.isPlaying ? (
                        <Pause className="h-5 w-5 fill-current" />
                    ) : (
                        <Play className="ml-0.5 h-5 w-5 fill-current" />
                    )}
                    <span>
                        {actions.isThisCollectionPlaying && actions.isPlaying
                            ? "Пауза"
                            : "Воспроизвести всё"}
                    </span>
                </button>

                {collection.tracks.length > 1 && (
                    <button
                        type="button"
                        onClick={actions.handleShuffle}
                        className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        title="Перемешать"
                        aria-label="Перемешать и воспроизвести"
                    >
                        <Shuffle className="h-5 w-5" />
                    </button>
                )}
            </div>

            <div
                data-detail-action-tier="secondary"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
            >
                <button
                    type="button"
                    onClick={actions.handleAddToQueue}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    title="Добавить всё в очередь"
                    aria-label="Добавить все треки в очередь"
                >
                    <ListMusic className="h-5 w-5" />
                </button>

                <button
                    type="button"
                    onClick={() => actions.setShowPlaylistSelector(true)}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    title="Добавить всё в плейлист"
                    aria-label="Добавить все треки в плейлист"
                >
                    <Plus className="h-5 w-5" />
                </button>

                {actions.likeableTracks.length > 0 && (
                    <LikeAllButton actions={actions} />
                )}

                <button
                    type="button"
                    onClick={() => router.back()}
                    className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    <span>Назад</span>
                </button>
            </div>
        </MusicDetailActionDock>
    );
}

function LikeAllButton({ actions }: { actions: Actions }) {
    const label = actions.isAllLiked
        ? "Убрать отметку «Нравится» у всех треков"
        : "Отметить все треки как понравившиеся";
    return (
        <button
            type="button"
            onClick={actions.toggleLikeAll}
            disabled={actions.isApplyingLikeAll}
            className={cn(
                "flex h-11 w-11 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                actions.isApplyingLikeAll
                    ? "cursor-not-allowed text-content-muted opacity-50"
                    : actions.isAllLiked
                      ? "text-brand hover:bg-white/10"
                      : "text-content-secondary hover:bg-white/10 hover:text-content",
            )}
            title={label}
            aria-label={label}
        >
            {actions.isApplyingLikeAll ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <Heart
                    className={cn(
                        "h-4 w-4",
                        actions.isAllLiked && "fill-current",
                    )}
                />
            )}
        </button>
    );
}

function EmptyTracks({ message }: { message: string }) {
    return (
        <EmptyState
            icon={<Music2 className="h-7 w-7" aria-hidden="true" />}
            title="Треки не найдены"
            description={message}
        />
    );
}
