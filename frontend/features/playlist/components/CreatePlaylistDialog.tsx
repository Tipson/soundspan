"use client";

import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { userFacingError } from "@/lib/i18n/ru";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { navigateAfterDismissedLayers } from "@/hooks/useDismissibleLayer";

export interface CreatedPlaylist {
    id: string;
    name: string;
    isPublic?: boolean;
}

interface CreatePlaylistDialogProps {
    isOpen: boolean;
    /**
     * Close the dialog. The created reason is emitted only when successful
     * creation delegates navigation to onCreated; the caller must not start a
     * competing close-route navigation. Cancel, Back and Escape omit the reason.
     */
    onClose: (reason?: "created") => void;
    onCreated?: (playlist: CreatedPlaylist) => void;
}

function toCreatedPlaylist(value: unknown): CreatedPlaylist {
    if (
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        !("name" in value) ||
        typeof value.id !== "string" ||
        typeof value.name !== "string"
    ) {
        throw new Error("Сервер не вернул созданный плейлист");
    }
    return {
        id: value.id,
        name: value.name,
        isPublic:
            "isPublic" in value && typeof value.isPublic === "boolean"
                ? value.isPublic
                : undefined,
    };
}

/** A focused create flow used by the Playlists collection page. */
export function CreatePlaylistDialog({
    isOpen,
    onClose,
    onCreated,
}: CreatePlaylistDialogProps) {
    const createdNavigationClose = useRef(false);
    const [name, setName] = useState("");
    const [isPublic, setIsPublic] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const closeDialog = () => {
        setName("");
        setIsPublic(false);
        setError(null);
        const reason = createdNavigationClose.current ? "created" : undefined;
        createdNavigationClose.current = false;
        onClose(reason);
    };

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const trimmedName = name.trim();
        if (!trimmedName || isCreating) return;

        setIsCreating(true);
        setError(null);
        try {
            const playlist = toCreatedPlaylist(
                await api.createPlaylist(trimmedName, isPublic),
            );
            window.dispatchEvent(
                new CustomEvent("playlist-created", { detail: playlist }),
            );
            if (onCreated) {
                createdNavigationClose.current = true;
                try {
                    navigateAfterDismissedLayers(() => onCreated(playlist));
                } finally {
                    createdNavigationClose.current = false;
                }
            } else {
                closeDialog();
            }
        } catch (caught) {
            sharedFrontendLogger.error("Failed to create playlist", caught);
            setError(
                userFacingError(
                    caught,
                    "Не удалось создать плейлист. Попробуйте ещё раз.",
                ),
            );
        } finally {
            setIsCreating(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={closeDialog}
            title="Новый плейлист"
            className="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                    <label
                        htmlFor="create-playlist-name"
                        className="mb-2 block text-sm font-semibold text-content"
                    >
                        Название
                    </label>
                    <input
                        id="create-playlist-name"
                        name="playlist-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        autoComplete="off"
                        maxLength={200}
                        placeholder="Например, В дорогу"
                        className="min-h-12 w-full rounded-[10px] border border-line bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-[border-color,box-shadow] placeholder:text-content-muted focus:border-brand focus:ring-2 focus:ring-brand/25"
                    />
                </div>

                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] border border-line px-4 py-3 text-sm text-content-secondary transition-colors hover:bg-surface-hover hover:text-content">
                    <input
                        type="checkbox"
                        checked={isPublic}
                        onChange={(event) => setIsPublic(event.target.checked)}
                        className="h-5 w-5 accent-brand"
                    />
                    Открыть доступ другим пользователям
                </label>

                {error && (
                    <p role="alert" className="text-sm text-error">
                        {error}
                    </p>
                )}

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button type="button" variant="ghost" onClick={closeDialog}>
                        Отмена
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        isLoading={isCreating}
                        disabled={!name.trim()}
                    >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        Создать плейлист
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
