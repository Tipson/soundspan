"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Heart } from "lucide-react";
import { useLikedPlaylistQuery, usePlaylistsQuery } from "@/hooks/useQueries";
import { DownloadsList } from "@/features/device-offline/components/DownloadsList";
import { useDeviceOffline } from "@/features/device-offline/DeviceOfflineProvider";
import { LibraryHeader } from "@/features/library/components/LibraryHeader";
import { LibraryOverview } from "@/features/library/components/LibraryOverview";
import {
    LibraryTabs,
    type LibraryTab,
} from "@/features/library/components/LibraryTabs";
import { PersonalPlaylistGrid } from "@/features/library/components/PersonalPlaylistGrid";
import { SavedMusicGrid } from "@/features/library/components/SavedMusicGrid";
import { useSavedMusicEntities } from "@/features/library/hooks/useSavedMusic";
import type {
    PersonalPlaylist,
    PersonalPlaylistItem,
} from "@/features/library/types";
import { pluralRu, ru } from "@/lib/i18n/ru";

const LIBRARY_TABS = new Set<LibraryTab>([
    "liked",
    "playlists",
    "albums",
    "artists",
    "downloads",
]);

function activeLibraryTab(value: string | null): LibraryTab {
    return value && LIBRARY_TABS.has(value as LibraryTab)
        ? (value as LibraryTab)
        : "liked";
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
}: {
    title: string;
    description: string;
}) {
    return (
        <div className="mb-4">
            <h2 className="text-xl font-black tracking-tight text-content sm:text-2xl">
                {title}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-5 text-content-muted">
                {description}
            </p>
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
    const likedTotal = likedQuery.data?.total ?? 0;

    return (
        <div className="relative min-h-screen bg-surface">
            <LibraryHeader />

            <main className="relative mx-auto max-w-[1800px] space-y-8 px-4 pt-8 sm:space-y-10 sm:px-6 sm:pt-10 lg:px-8">
                <LibraryOverview
                    likedTotal={likedTotal}
                    playlistTotal={playlists.length}
                    albumTotal={albumCollection.total}
                    artistTotal={artistCollection.total}
                    downloadTotal={readyDeviceDownloadTotal}
                />

                <LibraryTabs activeTab={activeTab} />

                {activeTab === "liked" && (
                    <section
                        data-library-view="liked"
                        aria-labelledby="liked-library-title"
                    >
                        <SectionHeading
                            title="Лайкнутые"
                            description="Треки, сохранённые в вашем аккаунте"
                        />
                        <Link
                            href="/playlist/my-liked"
                            className="group flex min-h-20 items-center gap-4 border-y border-white/[0.08] py-3 transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand/15 text-brand-light">
                                <Heart
                                    className="h-5 w-5 fill-current"
                                    aria-hidden="true"
                                />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span
                                    id="liked-library-title"
                                    className="block text-base font-bold text-content"
                                >
                                    Любимые треки
                                </span>
                                <span className="mt-1 block text-sm text-content-muted">
                                    {likedTotal}{" "}
                                    {pluralRu(likedTotal, [
                                        "трек",
                                        "трека",
                                        "треков",
                                    ])}
                                    {" · "}Открыть полный список
                                </span>
                            </span>
                            <ArrowRight
                                className="h-5 w-5 shrink-0 text-content-muted transition-transform group-hover:translate-x-1 motion-reduce:transition-none"
                                aria-hidden="true"
                            />
                        </Link>
                    </section>
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
            </main>
        </div>
    );
}
