"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Search, Sparkles } from "lucide-react";
import { useLikedPlaylistQuery, usePlaylistsQuery } from "@/hooks/useQueries";
import { DownloadsList } from "@/features/device-offline/components/DownloadsList";
import { useDeviceOffline } from "@/features/device-offline/DeviceOfflineProvider";
import { LibraryHeader } from "@/features/library/components/LibraryHeader";
import { LibraryOverview } from "@/features/library/components/LibraryOverview";
import { LibraryTabs } from "@/features/library/components/LibraryTabs";
import { PersonalPlaylistGrid } from "@/features/library/components/PersonalPlaylistGrid";
import { SavedMusicGrid } from "@/features/library/components/SavedMusicGrid";
import { useSavedMusicEntities } from "@/features/library/hooks/useSavedMusic";
import type {
    PersonalPlaylist,
    PersonalPlaylistItem,
    Tab,
} from "@/features/library/types";
import { ru } from "@/lib/i18n/ru";

const LIBRARY_TABS = new Set<Tab>([
    "overview",
    "playlists",
    "albums",
    "artists",
    "downloads",
]);

function activeLibraryTab(value: string | null): Tab {
    return value && LIBRARY_TABS.has(value as Tab)
        ? (value as Tab)
        : "overview";
}

function isPlaylistItem(value: unknown): value is PersonalPlaylistItem {
    return Boolean(
        value &&
        typeof value === "object" &&
        "id" in value &&
        typeof value.id === "string",
    );
}

function toPersonalPlaylist(value: unknown): PersonalPlaylist | null {
    if (
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        !("name" in value) ||
        typeof value.id !== "string" ||
        typeof value.name !== "string"
    ) {
        return null;
    }

    const record = value as Record<string, unknown>;
    return {
        id: value.id,
        name: value.name,
        trackCount:
            typeof record.trackCount === "number"
                ? record.trackCount
                : undefined,
        items: Array.isArray(record.items)
            ? record.items.filter(isPlaylistItem)
            : undefined,
        isOwner:
            typeof record.isOwner === "boolean" ? record.isOwner : undefined,
        isHidden:
            typeof record.isHidden === "boolean" ? record.isHidden : undefined,
    };
}

function SectionHeading({
    title,
    description,
    href,
}: {
    title: string;
    description: string;
    href?: string;
}) {
    return (
        <div className="mb-4 flex items-end justify-between gap-3 sm:gap-4">
            <div className="min-w-0">
                <h2 className="text-xl font-black tracking-tight text-content sm:text-2xl">
                    {title}
                </h2>
                <p className="mt-1 max-w-3xl text-sm leading-5 text-content-muted">
                    {description}
                </p>
            </div>
            {href && (
                <Link
                    href={href}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 py-2 text-sm font-semibold text-brand-light transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                >
                    Показать все
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
            )}
        </div>
    );
}

/** Personal, account-scoped music collection rather than a server-file browser. */
export default function LibraryPage() {
    const searchParams = useSearchParams();
    const activeTab = activeLibraryTab(searchParams.get("tab"));
    const albumCollection = useSavedMusicEntities("album");
    const artistCollection = useSavedMusicEntities("artist");
    const playlistsQuery = usePlaylistsQuery();
    const likedQuery = useLikedPlaylistQuery(1);
    const { records: deviceDownloads } = useDeviceOffline();
    const readyDeviceDownloadTotal = deviceDownloads.filter(
        (record) => record.status === "ready",
    ).length;

    const playlists = useMemo(
        () =>
            (playlistsQuery.data ?? [])
                .map(toPersonalPlaylist)
                .filter(
                    (playlist): playlist is PersonalPlaylist =>
                        playlist !== null &&
                        playlist.isOwner !== false &&
                        playlist.isHidden !== true,
                ),
        [playlistsQuery.data],
    );

    return (
        <div className="relative min-h-screen bg-surface pb-36 md:pb-28">
            <LibraryHeader />

            <div className="relative mx-auto -mt-5 max-w-[1800px] space-y-8 px-4 sm:space-y-10 sm:px-6 lg:px-8">
                <LibraryTabs activeTab={activeTab} />

                {activeTab === "overview" && (
                    <div className="space-y-9">
                        <LibraryOverview
                            likedTotal={likedQuery.data?.total ?? 0}
                            playlistTotal={playlists.length}
                            albumTotal={albumCollection.total}
                            artistTotal={artistCollection.total}
                            downloadTotal={readyDeviceDownloadTotal}
                        />

                        {playlistsQuery.isLoading ||
                        playlistsQuery.isError ||
                        playlists.length > 0 ? (
                            <section>
                                <SectionHeading
                                    title="Ваши плейлисты"
                                    description="Созданные и импортированные подборки"
                                    href="/library?tab=playlists"
                                />
                                <PersonalPlaylistGrid
                                    playlists={playlists.slice(0, 6)}
                                    isLoading={playlistsQuery.isLoading}
                                    isError={playlistsQuery.isError}
                                    onRetry={() =>
                                        void playlistsQuery.refetch()
                                    }
                                />
                            </section>
                        ) : null}

                        {albumCollection.isLoading ||
                        albumCollection.isError ||
                        albumCollection.items.length > 0 ? (
                            <section>
                                <SectionHeading
                                    title={ru.library.savedAlbums}
                                    description="Альбомы, которые вы сохранили"
                                    href="/library?tab=albums"
                                />
                                <SavedMusicGrid
                                    type="album"
                                    items={albumCollection.items.slice(0, 6)}
                                    isLoading={albumCollection.isLoading}
                                    isError={albumCollection.isError}
                                    onRetry={() =>
                                        void albumCollection.refetch()
                                    }
                                />
                            </section>
                        ) : null}

                        {artistCollection.isLoading ||
                        artistCollection.isError ||
                        artistCollection.items.length > 0 ? (
                            <section>
                                <SectionHeading
                                    title={ru.library.savedArtists}
                                    description="Исполнители, к которым хочется возвращаться"
                                    href="/library?tab=artists"
                                />
                                <SavedMusicGrid
                                    type="artist"
                                    items={artistCollection.items.slice(0, 6)}
                                    isLoading={artistCollection.isLoading}
                                    isError={artistCollection.isError}
                                    onRetry={() =>
                                        void artistCollection.refetch()
                                    }
                                />
                            </section>
                        ) : null}

                        {!playlistsQuery.isLoading &&
                            !playlistsQuery.isError &&
                            playlists.length === 0 &&
                            !albumCollection.isLoading &&
                            !albumCollection.isError &&
                            albumCollection.items.length === 0 &&
                            !artistCollection.isLoading &&
                            !artistCollection.isError &&
                            artistCollection.items.length === 0 && (
                                <section className="flex flex-col items-start rounded-3xl border border-white/8 bg-surface-raised p-6 sm:p-8">
                                    <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/15 text-brand-light">
                                        <Sparkles
                                            className="h-6 w-6"
                                            aria-hidden="true"
                                        />
                                    </span>
                                    <h2 className="mt-5 text-xl font-black text-content sm:text-2xl">
                                        Соберите коллекцию на свой вкус
                                    </h2>
                                    <p className="mt-2 max-w-xl text-sm leading-6 text-content-muted">
                                        Ставьте лайки, сохраняйте альбомы и
                                        исполнителей или импортируйте плейлисты.
                                        Коллекция доступна в аккаунте, а
                                        загрузки остаются на каждом устройстве.
                                    </p>
                                    <Link
                                        href="/search"
                                        className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    >
                                        <Search
                                            className="h-4 w-4"
                                            aria-hidden="true"
                                        />
                                        Найти музыку
                                    </Link>
                                </section>
                            )}
                    </div>
                )}

                {activeTab === "playlists" && (
                    <section>
                        <SectionHeading
                            title={ru.library.playlists}
                            description="Ваши миксы и импортированные плейлисты"
                        />
                        <PersonalPlaylistGrid
                            playlists={playlists}
                            isLoading={playlistsQuery.isLoading}
                            isError={playlistsQuery.isError}
                            onRetry={() => void playlistsQuery.refetch()}
                        />
                    </section>
                )}

                {activeTab === "albums" && (
                    <section>
                        <SectionHeading
                            title={ru.library.savedAlbums}
                            description="Сохранённые альбомы. Загрузки выбираются отдельно на каждом устройстве."
                        />
                        <SavedMusicGrid
                            type="album"
                            items={albumCollection.items}
                            isLoading={albumCollection.isLoading}
                            isError={albumCollection.isError}
                            hasMore={albumCollection.hasNextPage}
                            isLoadingMore={albumCollection.isFetchingNextPage}
                            onLoadMore={() =>
                                void albumCollection.fetchNextPage()
                            }
                            onRetry={() => void albumCollection.refetch()}
                        />
                    </section>
                )}

                {activeTab === "artists" && (
                    <section>
                        <SectionHeading
                            title={ru.library.savedArtists}
                            description="Сохранённые исполнители из музыкального каталога"
                        />
                        <SavedMusicGrid
                            type="artist"
                            items={artistCollection.items}
                            isLoading={artistCollection.isLoading}
                            isError={artistCollection.isError}
                            hasMore={artistCollection.hasNextPage}
                            isLoadingMore={artistCollection.isFetchingNextPage}
                            onLoadMore={() =>
                                void artistCollection.fetchNextPage()
                            }
                            onRetry={() => void artistCollection.refetch()}
                        />
                    </section>
                )}

                {activeTab === "downloads" && (
                    <section>
                        <SectionHeading
                            title={ru.library.deviceDownloads}
                            description="Офлайн-музыка хранится обычными файлами на телефоне или компьютере. Доступ к папке относится к этому профилю браузера; очистка данных сайта не удаляет файлы и не затрагивает другие устройства."
                        />
                        <DownloadsList />
                    </section>
                )}
            </div>
        </div>
    );
}
