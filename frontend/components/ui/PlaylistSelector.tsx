"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { Plus, Music2, Check } from "lucide-react";
import { GradientSpinner } from "./GradientSpinner";
import { Modal } from "./Modal";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { pluralRu, ru, userFacingError } from "@/lib/i18n/ru";

interface PlaylistSelectorProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectPlaylist: (playlistId: string) => Promise<void>;
    isLoading?: boolean;
    loadingMessage?: string;
    /** When true, allow selecting multiple playlists before confirming. */
    multiSelect?: boolean;
}

interface PlaylistOption {
    id: string;
    name: string;
    trackCount?: number;
    isOwner?: boolean;
}

/**
 * Renders the PlaylistSelector component.
 */
export function PlaylistSelector({
    isOpen,
    onClose,
    onSelectPlaylist,
    isLoading: isSaving,
    loadingMessage,
    multiSelect = false,
}: PlaylistSelectorProps) {
    const [playlists, setPlaylists] = useState<PlaylistOption[]>([]);
    const [newPlaylistName, setNewPlaylistName] = useState("");
    const [isPublic, setIsPublic] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isConfirming, setIsConfirming] = useState(false);
    const [confirmError, setConfirmError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [createdPlaylistAwaitingAdd, setCreatedPlaylistAwaitingAdd] =
        useState<PlaylistOption | null>(null);
    const actionInFlightRef = useRef(false);
    const isProcessing = isSaving || isConfirming || isCreating;

    const loadPlaylists = useCallback(async () => {
        try {
            setIsLoading(true);
            setActionError(null);
            const data = await api.getPlaylists();
            setPlaylists(
                Array.isArray(data)
                    ? data.filter(
                          (playlist) => playlist && playlist.isOwner !== false,
                      )
                    : [],
            );
        } catch (error) {
            sharedFrontendLogger.error("Failed to load playlists:", error);
            setActionError(userFacingError(error, ru.selector.loadFailed));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        let active = true;
        queueMicrotask(() => {
            if (!active) return;
            void loadPlaylists();
            setSelectedIds(new Set());
            setConfirmError(null);
            setActionError(null);
        });
        return () => {
            active = false;
        };
    }, [isOpen, loadPlaylists]);

    const handleCreatePlaylist = async () => {
        const playlistName = newPlaylistName.trim();
        if (
            (!createdPlaylistAwaitingAdd && !playlistName) ||
            actionInFlightRef.current ||
            isCreating ||
            isProcessing
        ) {
            return;
        }

        actionInFlightRef.current = true;
        setIsCreating(true);
        setActionError(null);
        try {
            let playlist = createdPlaylistAwaitingAdd;
            if (!playlist) {
                try {
                    const createdPlaylist = await api.createPlaylist(
                        playlistName,
                        isPublic,
                    );
                    const createdOption: PlaylistOption = {
                        ...createdPlaylist,
                        id: createdPlaylist.id,
                        name: createdPlaylist.name || playlistName,
                        isOwner: true,
                    };
                    playlist = createdOption;
                    setCreatedPlaylistAwaitingAdd(createdOption);
                    setPlaylists((current) => [
                        createdOption,
                        ...current.filter(
                            (item) => item.id !== createdOption.id,
                        ),
                    ]);
                    window.dispatchEvent(
                        new CustomEvent("playlist-created", {
                            detail: createdOption,
                        }),
                    );
                } catch (error) {
                    sharedFrontendLogger.error(
                        "Failed to create playlist:",
                        error,
                    );
                    setActionError(
                        userFacingError(error, ru.selector.createFailed),
                    );
                    return;
                }
            }

            if (!playlist) return;

            try {
                await onSelectPlaylist(playlist.id);
            } catch (error) {
                sharedFrontendLogger.error(
                    "Failed to add to newly created playlist:",
                    error,
                );
                setActionError(
                    userFacingError(error, ru.selector.createdAddFailed),
                );
                return;
            }

            setCreatedPlaylistAwaitingAdd(null);
            setNewPlaylistName("");
            setIsPublic(false);
            window.dispatchEvent(
                new CustomEvent("playlist-updated", {
                    detail: { playlistId: playlist.id },
                }),
            );
            onClose();
        } finally {
            actionInFlightRef.current = false;
            setIsCreating(false);
        }
    };

    const handleSelectPlaylist = async (playlistId: string) => {
        if (actionInFlightRef.current || isProcessing) return;

        if (multiSelect) {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(playlistId)) {
                    next.delete(playlistId);
                } else {
                    next.add(playlistId);
                }
                return next;
            });
            return;
        }

        actionInFlightRef.current = true;
        try {
            setActionError(null);
            await onSelectPlaylist(playlistId);
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } }),
            );
            setCreatedPlaylistAwaitingAdd(null);
            await loadPlaylists();
            onClose();
        } catch (error) {
            sharedFrontendLogger.error("Failed to add to playlist:", error);
            setActionError(userFacingError(error, ru.selector.addFailed));
        } finally {
            actionInFlightRef.current = false;
        }
    };

    const handleConfirmMulti = async () => {
        if (
            selectedIds.size === 0 ||
            actionInFlightRef.current ||
            isProcessing
        ) {
            return;
        }

        actionInFlightRef.current = true;
        setIsConfirming(true);
        setConfirmError(null);
        let failures = 0;

        for (const playlistId of selectedIds) {
            try {
                await onSelectPlaylist(playlistId);
                window.dispatchEvent(
                    new CustomEvent("playlist-updated", {
                        detail: { playlistId },
                    }),
                );
            } catch (error) {
                failures++;
                sharedFrontendLogger.error(
                    `Failed to add to playlist ${playlistId}:`,
                    error,
                );
            }
        }

        try {
            if (failures > 0) {
                setConfirmError(
                    `Не удалось добавить в ${failures} ${pluralRu(failures, ["плейлист", "плейлиста", "плейлистов"])}`,
                );
            } else {
                setCreatedPlaylistAwaitingAdd(null);
                await loadPlaylists();
                onClose();
            }
        } finally {
            actionInFlightRef.current = false;
            setIsConfirming(false);
        }
    };

    if (!isOpen || typeof document === "undefined") return null;

    return createPortal(
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={ru.selector.title}
            className="flex max-h-[min(92dvh,760px)] max-w-lg flex-col overflow-hidden p-0"
            headerClassName="mb-0 shrink-0 px-5 pt-5 sm:px-6 sm:pt-6"
            contentClassName="mb-0 min-h-0 flex-1 overflow-y-auto"
            footerClassName="block shrink-0 border-t border-line bg-surface-elevated/70 p-4 sm:p-6"
            footer={
                <div
                    data-playlist-selector="create"
                    className="w-full space-y-4"
                >
                    {actionError && (
                        <div
                            role="alert"
                            className="rounded-xl border border-error/20 bg-error/10 px-4 py-3 text-sm text-error"
                        >
                            {actionError}
                        </div>
                    )}

                    {multiSelect && selectedIds.size > 0 && (
                        <button
                            onClick={() => void handleConfirmMulti()}
                            disabled={isProcessing}
                            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-brand px-5 py-3 font-semibold text-black transition-[filter,transform] hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                        >
                            {isConfirming ? (
                                <>
                                    <GradientSpinner size="sm" />
                                    {ru.selector.adding}
                                </>
                            ) : (
                                `Добавить в ${selectedIds.size} ${pluralRu(selectedIds.size, ["плейлист", "плейлиста", "плейлистов"])}`
                            )}
                        </button>
                    )}

                    <div>
                        <label
                            htmlFor="playlist-selector-name"
                            className="mb-2 block text-sm font-semibold text-content"
                        >
                            {ru.selector.createNew}
                        </label>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <input
                                id="playlist-selector-name"
                                name="playlist-name"
                                type="text"
                                placeholder={ru.selector.playlistName}
                                value={newPlaylistName}
                                maxLength={200}
                                disabled={
                                    Boolean(createdPlaylistAwaitingAdd) ||
                                    isCreating ||
                                    isProcessing
                                }
                                onChange={(e) =>
                                    setNewPlaylistName(e.target.value)
                                }
                                onKeyDown={(e) =>
                                    e.key === "Enter" &&
                                    void handleCreatePlaylist()
                                }
                                className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-surface-hover px-4 py-3 text-content outline-none transition-[border-color,box-shadow] placeholder:text-content-muted focus:border-brand focus:ring-2 focus:ring-brand/25"
                            />
                            <button
                                onClick={() => void handleCreatePlaylist()}
                                disabled={
                                    (!createdPlaylistAwaitingAdd &&
                                        !newPlaylistName.trim()) ||
                                    isCreating ||
                                    isProcessing
                                }
                                className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 font-bold text-black transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-45"
                            >
                                {isCreating ? (
                                    <GradientSpinner size="sm" />
                                ) : (
                                    <Plus
                                        className="h-5 w-5"
                                        aria-hidden="true"
                                    />
                                )}
                                {createdPlaylistAwaitingAdd
                                    ? ru.selector.retryCreatedAdd
                                    : ru.selector.create}
                            </button>
                        </div>
                    </div>

                    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-content-muted transition-colors hover:text-content">
                        <input
                            type="checkbox"
                            checked={isPublic}
                            disabled={
                                Boolean(createdPlaylistAwaitingAdd) ||
                                isCreating ||
                                isProcessing
                            }
                            onChange={(e) => setIsPublic(e.target.checked)}
                            className="h-5 w-5 accent-brand"
                        />
                        {ru.selector.shareWithUsers}
                    </label>
                </div>
            }
        >
            <div
                data-playlist-selector="options"
                className="space-y-2 overscroll-contain px-4 py-4 sm:px-6"
            >
                {isProcessing && (
                    <div className="mb-3 flex items-center gap-3 rounded-xl border border-line bg-surface-hover px-4 py-3 text-sm text-content-secondary">
                        <GradientSpinner size="sm" />
                        <span>{loadingMessage || ru.selector.adding}</span>
                    </div>
                )}

                {confirmError && (
                    <div
                        role="alert"
                        className="mb-3 rounded-xl border border-error/20 bg-error/10 px-4 py-3 text-sm text-error"
                    >
                        {confirmError}
                    </div>
                )}

                {isLoading ? (
                    <div className="flex items-center justify-center py-12">
                        <GradientSpinner size="md" />
                    </div>
                ) : playlists.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                        <Music2 className="mb-3 h-12 w-12 text-content-muted" />
                        <p className="text-content-secondary">
                            {ru.selector.noPlaylists}
                        </p>
                        <p className="mt-1 text-sm text-content-muted">
                            {ru.selector.createHint}
                        </p>
                    </div>
                ) : (
                    playlists.map((playlist) => {
                        const isSelected = selectedIds.has(playlist.id);
                        return (
                            <button
                                key={playlist.id}
                                onClick={() =>
                                    void handleSelectPlaylist(playlist.id)
                                }
                                className={`group w-full rounded-xl border px-4 py-4 text-left transition-colors ${
                                    isSelected
                                        ? "border-brand/30 bg-brand/10"
                                        : "border-line bg-surface-elevated hover:border-line-muted hover:bg-surface-hover"
                                }`}
                                disabled={isProcessing}
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                        <p
                                            className={`break-words font-semibold transition-colors ${
                                                isSelected
                                                    ? "text-brand"
                                                    : "text-content group-hover:text-brand-light"
                                            }`}
                                        >
                                            {playlist.name}
                                        </p>
                                        <p className="mt-1 text-xs text-content-muted">
                                            {playlist.trackCount || 0}{" "}
                                            {pluralRu(
                                                playlist.trackCount || 0,
                                                ["трек", "трека", "треков"],
                                            )}
                                        </p>
                                    </div>
                                    {multiSelect && isSelected ? (
                                        <span className="ml-2 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand">
                                            <Check className="h-3.5 w-3.5 text-black" />
                                        </span>
                                    ) : (
                                        <Plus className="ml-2 h-5 w-5 shrink-0 text-content-muted transition-colors group-hover:text-brand-light" />
                                    )}
                                </div>
                            </button>
                        );
                    })
                )}
            </div>
        </Modal>,
        document.body,
    );
}
