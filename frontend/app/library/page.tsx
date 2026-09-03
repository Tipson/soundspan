"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { HardDriveDownload, Heart } from "lucide-react";
import { useLikedPlaylistQuery, usePlaylistsQuery } from "@/hooks/useQueries";
import { DownloadsList } from "@/features/device-offline/components/DownloadsList";
import { useOptionalDeviceOffline } from "@/features/device-offline/DeviceOfflineProvider";
import { LibraryHeader } from "@/features/library/components/LibraryHeader";
import {
    LibraryTabs,
    type LibraryTab,
} from "@/features/library/components/LibraryTabs";
import { PersonalPlaylistGrid } from "@/features/library/components/PersonalPlaylistGrid";
import { LibraryPlaylistCard } from "@/features/library/components/LibraryPlaylistCard";
import { SavedMusicGrid } from "@/features/library/components/SavedMusicGrid";
import { useSavedMusicEntities } from "@/features/library/hooks/useSavedMusic";
import type {
    PersonalPlaylist,
    PersonalPlaylistItem,
} from "@/features/library/types";
import { ru } from "@/lib/i18n/ru";

type LibraryView = LibraryTab | "downloads";

const LIBRARY_VIEWS = new Set<LibraryView>([
    "playlists",
    "albums",
    "artists",
    "downloads",
]);

function activeLibraryView(value: string | null): LibraryView {
    return value && LIBRARY_VIEWS.has(value as LibraryView)
        ? (value as LibraryView)
        : "playlists";
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
    id,
    title,
    description,
}: {
    id?: string;
    title: string;
    description: string;
}) {
    return (
        <div className="mb-4">
            <h2
                id={id}
                className="text-xl font-black tracking-tight text-content sm:text-2xl"
            >
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
    const activeView = activeLibraryView(searchParams.get("tab"));
    const albumCollection = useSavedMusicEntities("album");
    const artistCollection = useSavedMusicEntities("artist");
    const playlistsQuery = usePlaylistsQuery();
    const likedQuery = useLikedPlaylistQuery(1);
    const deviceOffline = useOptionalDeviceOffline();

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
    const downloadedTotal = useMemo(
        () =>
            new Set(
                deviceOffline?.records
                    .filter((record) => record.status === "ready")
                    .map((record) => record.trackIdentity) ?? [],
            ).size,
        [deviceOffline?.records],
    );

    return (
        <div className="relative min-h-screen bg-surface">
            <LibraryHeader />

            <main className="relative mx-auto max-w-[1800px] space-y-8 px-4 pt-8 sm:space-y-10 sm:px-6 sm:pt-10 lg:px-8">
                <LibraryTabs
                    activeTab={
                        activeView === "downloads" ? "playlists" : activeView
                    }
                />

                {activeView === "playlists" && (
                    <section
                        data-library-view="playlists"
                        aria-labelledby="playlist-library-title"
                    >
                        <SectionHeading
                            id="playlist-library-title"
                            title={ru.library.playlists}
                            description="Любимые треки, ваши плейлисты и музыка, сохранённая на этом устройстве"
                        />
                        <div className="mt-2">
                            <PersonalPlaylistGrid
                                playlists={playlists}
                                isLoading={playlistsQuery.isLoading}
                                isError={playlistsQuery.isError}
                                onRetry={() => void playlistsQuery.refetch()}
                                leadingCards={
                                    <>
                                        <LibraryPlaylistCard
                                            href="/playlist/my-liked"
                                            title="Любимые треки"
                                            trackCount={likedTotal}
                                            icon={Heart}
                                            accent="liked"
                                        />
                                        <LibraryPlaylistCard
                                            href="/library?tab=downloads"
                                            title="Загруженное"
                                            trackCount={downloadedTotal}
                                            icon={HardDriveDownload}
                                            accent="downloaded"
                                        />
                                    </>
                                }
                            />
                        </div>
                    </section>
                )}

                {activeView === "downloads" && (
                    <section
                        data-library-view="downloads"
                        aria-labelledby="device-downloads-title"
                    >
                        <SectionHeading
                            id="device-downloads-title"
                            title="Загруженное"
                            description="Музыка для офлайн-прослушивания на этом устройстве. На телефонах Soundspan хранит её в закрытом хранилище приложения; отдельный обычный файл можно сохранить вручную."
                        />
                        <DownloadsList />
                    </section>
                )}

                {activeView === "albums" && (
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

                {activeView === "artists" && (
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
            </main>
        </div>
    );
}
