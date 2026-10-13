"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { HardDriveDownload, Heart, Plus, Upload } from "lucide-react";
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
import { CreatePlaylistDialog } from "@/features/playlist/components/CreatePlaylistDialog";
import { shouldOpenCreatePlaylist } from "@/features/playlist/createPlaylistRoute";
import { ru } from "@/lib/i18n/ru";
import { useNetworkOnline } from "@/hooks/useNetworkOnline";
import { navigateWhenLayersDismissed } from "@/hooks/useDismissibleLayer";

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
                className="text-xl font-semibold tracking-tight text-content sm:text-2xl"
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
    const router = useRouter();
    const searchParams = useSearchParams();
    const activeView = activeLibraryView(searchParams.get("tab"));
    const online = useNetworkOnline();
    const albumCollection = useSavedMusicEntities("album");
    const artistCollection = useSavedMusicEntities("artist");
    const playlistsQuery = usePlaylistsQuery();
    const likedQuery = useLikedPlaylistQuery(1);
    const deviceOffline = useOptionalDeviceOffline();
    const [isCreateDialogOpenManually, setIsCreateDialogOpenManually] =
        useState(false);
    const pendingCreateQueryCleanup = useRef<{ url: string } | null>(null);
    const createQuery = searchParams.get("create");
    const [createDialogQuery, setCreateDialogQuery] = useState({
        query: createQuery,
        dismissed: false,
    });
    if (createDialogQuery.query !== createQuery) {
        // A fresh URL intent may reopen the dialog after its previous close.
        setCreateDialogQuery({ query: createQuery, dismissed: false });
    }
    const isCreateDialogOpen =
        isCreateDialogOpenManually ||
        (shouldOpenCreatePlaylist(createQuery) && !createDialogQuery.dismissed);

    useEffect(() => {
        if (isCreateDialogOpen) return;
        const intent = pendingCreateQueryCleanup.current;
        pendingCreateQueryCleanup.current = null;
        if (!intent || window.location.href !== intent.url) return;
        // Child layer cleanup has committed. Preserve any lower player layer
        // and wait for its dismissal before replacing the real base entry.
        navigateWhenLayersDismissed(() => {
            if (window.location.href !== intent.url) return;
            router.replace("/library?tab=playlists", { scroll: false });
        });
    }, [isCreateDialogOpen, router]);

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

            <div className="relative mx-auto max-w-[1800px] space-y-5 px-4 pt-4 sm:space-y-7 sm:px-6 sm:pt-6 lg:px-8">
                <LibraryTabs
                    activeTab={activeView === "downloads" ? null : activeView}
                />

                {!online && activeView !== "downloads" && (
                    <section className="space-y-4">
                        <p role="status" className="text-sm text-content-muted">
                            Для просмотра полной коллекции нужен интернет. Ниже
                            — музыка, скачанная на это устройство.
                        </p>
                        <DownloadsList />
                    </section>
                )}
                {online && activeView === "playlists" && (
                    <section
                        data-library-view="playlists"
                        aria-labelledby="playlist-library-title"
                    >
                        <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                            <SectionHeading
                                id="playlist-library-title"
                                title={ru.library.playlists}
                                description="Любимые треки, ваши плейлисты и музыка, сохранённая на этом устройстве"
                            />
                            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                                <button
                                    type="button"
                                    aria-label="Создать плейлист"
                                    onClick={() =>
                                        setIsCreateDialogOpenManually(true)
                                    }
                                    className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] bg-brand px-4 py-2 text-sm font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                >
                                    <Plus
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                    <span className="sm:hidden">Создать</span>
                                    <span className="hidden sm:inline">
                                        Создать плейлист
                                    </span>
                                </button>
                                <Link
                                    href="/import"
                                    aria-label="Импортировать плейлист"
                                    className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-line bg-surface-elevated px-4 py-2 text-sm font-semibold text-content transition-colors hover:border-white/25 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                >
                                    <Upload
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                    <span className="sm:hidden">Импорт</span>
                                    <span className="hidden sm:inline">
                                        Импортировать плейлист
                                    </span>
                                </Link>
                            </div>
                        </div>
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
                            description="Слушайте без интернета на этом устройстве."
                        />
                        <DownloadsList />
                    </section>
                )}

                {online && activeView === "albums" && (
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

                {online && activeView === "artists" && (
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
            </div>
            <CreatePlaylistDialog
                isOpen={isCreateDialogOpen}
                onClose={(reason) => {
                    pendingCreateQueryCleanup.current =
                        reason !== "created" &&
                        shouldOpenCreatePlaylist(createQuery)
                            ? { url: window.location.href }
                            : null;
                    setIsCreateDialogOpenManually(false);
                    setCreateDialogQuery({
                        query: createQuery,
                        dismissed: true,
                    });
                }}
                onCreated={(playlist) => {
                    if (shouldOpenCreatePlaylist(searchParams.get("create"))) {
                        // The layer guard is already consumed. Clean only the
                        // real base entry, keeping its current Next snapshot.
                        window.history.replaceState(
                            window.history.state,
                            "",
                            "/library?tab=playlists",
                        );
                    }
                    router.push(`/playlist/${encodeURIComponent(playlist.id)}`);
                }}
            />
        </div>
    );
}
