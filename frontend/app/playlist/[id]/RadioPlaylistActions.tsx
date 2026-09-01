"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ListPlus, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { useToast } from "@/lib/toast-context";
import { queryKeys } from "@/lib/queryKeys";
import { pluralRu, ru } from "@/lib/i18n/ru";

interface RadioPlaylistActionsProps {
    enabled: boolean;
    playlistId: string;
}

function useRadioPlaylistActions(playlistId: string) {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const [activeAction, setActiveAction] = useState<
        "append" | "regenerate" | null
    >(null);

    const refresh = async () => {
        await queryClient.invalidateQueries({
            queryKey: queryKeys.playlist(playlistId),
        });
        window.dispatchEvent(
            new CustomEvent("playlist-updated", { detail: { playlistId } }),
        );
    };

    const addMore = async () => {
        setActiveAction("append");
        try {
            const result = await api.appendRadioPlaylist(playlistId);
            await refresh();
            if (result.entries.length === 0) {
                toast.info(ru.playlist.noMore);
            } else {
                toast.success(
                    `Добавлено: ${result.entries.length} ${pluralRu(result.entries.length, ["трек", "трека", "треков"])}`,
                );
            }
        } catch (error) {
            sharedFrontendLogger.error("Failed to add radio tracks:", error);
            toast.error(ru.playlist.addMoreFailed);
        } finally {
            setActiveAction(null);
        }
    };

    const regenerate = async () => {
        setActiveAction("regenerate");
        try {
            const result = await api.regenerateRadioPlaylist(playlistId);
            await refresh();
            toast.success(
                `Плейлист собран заново: ${result.entries.length} ${pluralRu(result.entries.length, ["трек", "трека", "треков"])}`,
            );
        } catch (error) {
            sharedFrontendLogger.error("Failed to regenerate playlist:", error);
            toast.error(ru.playlist.regenerateFailed);
        } finally {
            setActiveAction(null);
        }
    };

    return { activeAction, addMore, regenerate };
}

/** Executes and renders actions available only for generated radio playlists. */
export function RadioPlaylistActions({
    enabled,
    playlistId,
}: RadioPlaylistActionsProps) {
    const { activeAction, addMore, regenerate } =
        useRadioPlaylistActions(playlistId);
    if (!enabled) return null;
    const isWorking = activeAction !== null;
    return (
        <>
            <button
                type="button"
                onClick={() => void addMore()}
                disabled={isWorking}
                className="flex items-center gap-2 px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {activeAction === "append" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                    <ListPlus className="w-4 h-4" />
                )}
                {ru.playlist.addMore}
            </button>
            <button
                type="button"
                onClick={() => void regenerate()}
                disabled={isWorking}
                className="flex items-center gap-2 px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {activeAction === "regenerate" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                    <RefreshCw className="w-4 h-4" />
                )}
                {ru.playlist.regenerate}
            </button>
        </>
    );
}
