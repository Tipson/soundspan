"use client";

import { useId, useState } from "react";
import { Edit, Save } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { GradientSpinner } from "./ui/GradientSpinner";
import { MusicBrainzLookup } from "./ui/MusicBrainzLookup";
import Image from "next/image";
import { userFacingError } from "@/lib/i18n/ru";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface MetadataEditorProps {
    type: "artist" | "album" | "track";
    id: string;
    currentData: {
        name?: string;
        title?: string;
        bio?: string | null;
        genres?: string[];
        year?: number | null;
        mbid?: string;
        rgMbid?: string;
        coverUrl?: string | null;
        heroUrl?: string | null;
        // Original values for comparison (when user overrides exist)
        _originalName?: string;
        _originalBio?: string | null;
        _originalGenres?: string[];
        _originalHeroUrl?: string | null;
        _originalTitle?: string;
        _originalYear?: number | null;
        _originalCoverUrl?: string | null;
        _hasUserOverrides?: boolean;
    };
    artistName?: string;
    onSave?: (updatedData: Record<string, unknown> | null) => void;
}

type MetadataFormField =
    | "name"
    | "title"
    | "bio"
    | "genres"
    | "year"
    | "mbid"
    | "rgMbid"
    | "coverUrl"
    | "heroUrl";

interface MetadataEditorApiErrorData {
    error?: string;
    message?: string;
    code?: string;
    field?: string;
    hint?: string;
    expectedFormat?: string;
}

interface MetadataEditorApiError extends Error {
    status?: number;
    data?: MetadataEditorApiErrorData;
}

function toMetadataEditorApiError(
    error: unknown,
): MetadataEditorApiError | null {
    if (!error || typeof error !== "object") {
        return null;
    }
    const candidate = error as MetadataEditorApiError;
    return candidate.data || typeof candidate.status === "number"
        ? candidate
        : null;
}

/**
 * Metadata Editor Component
 * Plex/Kavita-style metadata editor with pencil icon
 * Opens a modal for editing artist/album/track metadata
 */
export function MetadataEditor({
    type,
    id,
    currentData,
    artistName,
    onSave,
}: MetadataEditorProps) {
    const fieldId = useId();
    const [isOpen, setIsOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [formData, setFormData] = useState(currentData);
    const [formError, setFormError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<
        Partial<Record<MetadataFormField, string>>
    >({});
    const hasOverrides = currentData._hasUserOverrides ?? false;
    const mbidField = type === "album" ? "rgMbid" : "mbid";
    const mbidFieldError = fieldErrors[mbidField];

    const handleOpen = () => {
        setFormData(currentData);
        setFormError(null);
        setFieldErrors({});
        setIsOpen(true);
    };

    const handleClose = () => {
        setShowResetConfirm(false);
        setIsOpen(false);
        setFormData(currentData);
        setFormError(null);
        setFieldErrors({});
    };

    const confirmReset = async () => {
        setIsResetting(true);
        try {
            if (type === "artist") {
                await api.resetArtistMetadata(id);
            } else if (type === "album") {
                await api.resetAlbumMetadata(id);
            } else {
                await api.resetTrackMetadata(id);
            }

            toast.success("Исходные метаданные восстановлены");
            onSave?.(null);
            setIsOpen(false);
        } catch (error: unknown) {
            toast.error(
                userFacingError(error, "Не удалось восстановить метаданные"),
            );
        } finally {
            setIsResetting(false);
        }
    };

    const handleSave = async () => {
        setFormError(null);
        setFieldErrors({});
        setIsSaving(true);
        try {
            // Call API to update metadata
            let response;
            if (type === "artist") {
                response = await api.updateArtistMetadata(id, formData);
            } else if (type === "album") {
                response = await api.updateAlbumMetadata(id, formData);
            } else {
                response = await api.updateTrackMetadata(id, formData);
            }

            toast.success(
                `${
                    type === "artist"
                        ? "Исполнитель"
                        : type === "album"
                          ? "Альбом"
                          : "Трек"
                }: метаданные обновлены`,
            );
            onSave?.(response);
            setIsOpen(false);
        } catch (error: unknown) {
            sharedFrontendLogger.error("Failed to update metadata:", error);
            const apiError = toMetadataEditorApiError(error);
            if (apiError?.data) {
                const apiField =
                    typeof apiError.data.field === "string"
                        ? apiError.data.field
                        : null;
                const message =
                    typeof apiError.data.error === "string" &&
                    apiError.data.error
                        ? apiError.data.error
                        : apiError instanceof Error && apiError.message
                          ? apiError.message
                          : "Не удалось обновить метаданные";
                const hint =
                    typeof apiError.data.hint === "string"
                        ? apiError.data.hint
                        : null;
                const expectedFormat =
                    typeof apiError.data.expectedFormat === "string"
                        ? apiError.data.expectedFormat
                        : null;
                const fallbackMessage = "Не удалось обновить метаданные";
                const localizedMessage = userFacingError(
                    message,
                    fallbackMessage,
                );
                const fieldMessage = expectedFormat
                    ? `Неверный формат. Ожидается: ${expectedFormat}`
                    : localizedMessage;

                if (
                    apiField === "mbid" ||
                    apiField === "rgMbid" ||
                    apiField === "name" ||
                    apiField === "title" ||
                    apiField === "bio" ||
                    apiField === "genres" ||
                    apiField === "year" ||
                    apiField === "coverUrl" ||
                    apiField === "heroUrl"
                ) {
                    setFieldErrors((prev) => ({
                        ...prev,
                        [apiField]: fieldMessage,
                    }));
                }

                if (apiError.status === 409 && hint) {
                    const localizedHint = userFacingError(
                        hint,
                        "Проверьте значения и повторите попытку",
                    );
                    setFormError(`${localizedMessage}. ${localizedHint}`);
                    toast.error(`${localizedMessage}. ${localizedHint}`);
                } else {
                    setFormError(localizedMessage);
                    toast.error(localizedMessage);
                }
            } else {
                const fallbackMessage = userFacingError(
                    error,
                    "Не удалось обновить метаданные",
                );
                setFormError(fallbackMessage);
                toast.error(fallbackMessage);
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleChange = (
        field: string,
        value: string | number | string[] | null,
    ) => {
        if (formError) {
            setFormError(null);
        }
        if (
            field === "mbid" ||
            field === "rgMbid" ||
            field === "name" ||
            field === "title" ||
            field === "bio" ||
            field === "genres" ||
            field === "year" ||
            field === "coverUrl" ||
            field === "heroUrl"
        ) {
            setFieldErrors((prev) => {
                if (!prev[field]) {
                    return prev;
                }
                const next = { ...prev };
                delete next[field];
                return next;
            });
        }
        setFormData((prev) => ({ ...prev, [field]: value }));
    };
    const previewImageUrl = formData.heroUrl || formData.coverUrl;

    return (
        <>
            {/* Pencil Icon Button */}
            <button
                onClick={handleOpen}
                type="button"
                aria-label="Редактировать метаданные"
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface-elevated text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                title="Редактировать метаданные"
            >
                <Edit className="w-4 h-4 text-white" />
            </button>

            <Modal
                isOpen={isOpen}
                onClose={handleClose}
                title={`Редактирование: ${type === "artist" ? "исполнитель" : type === "album" ? "альбом" : "трек"}`}
                className="max-w-2xl"
                footerClassName="flex-col sm:flex-row sm:flex-wrap"
                footer={
                    <>
                        {hasOverrides && (
                            <button
                                onClick={() => setShowResetConfirm(true)}
                                disabled={isSaving || isResetting}
                                className="min-h-11 px-4 py-2 rounded-[10px] bg-red-500/20 hover:bg-red-500/30 text-red-400 font-bold transition-all border border-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isResetting
                                    ? "Восстанавливаем…"
                                    : "Вернуть исходные"}
                            </button>
                        )}
                        <button
                            onClick={handleClose}
                            className="min-h-11 px-4 py-2 rounded-[10px] bg-white/10 hover:bg-white/20 text-white font-bold transition-all"
                            disabled={isSaving}
                        >
                            Отмена
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="min-h-11 px-4 py-2 rounded-[10px] bg-brand-hover hover:bg-brand text-black font-bold transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isSaving ? (
                                <>
                                    <GradientSpinner size="sm" />
                                    Сохраняем…
                                </>
                            ) : (
                                <>
                                    <Save className="w-4 h-4" />
                                    Сохранить изменения
                                </>
                            )}
                        </button>
                    </>
                }
            >
                {/* Content */}
                <div className="space-y-4">
                    {formError && (
                        <div
                            role="alert"
                            className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
                        >
                            {formError}
                        </div>
                    )}

                    {/* Name/Title */}
                    <div>
                        <label
                            htmlFor={fieldId + "-name"}
                            className="block text-sm font-bold text-white mb-2"
                        >
                            {type === "artist"
                                ? "Имя исполнителя"
                                : type === "album"
                                  ? "Название альбома"
                                  : "Название трека"}
                        </label>
                        <input
                            id={fieldId + "-name"}
                            type="text"
                            value={formData.name || formData.title || ""}
                            onChange={(e) =>
                                handleChange(
                                    type === "artist" ? "name" : "title",
                                    e.target.value,
                                )
                            }
                            className="w-full px-4 py-2 bg-surface-elevated border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                        />
                        {type === "artist" &&
                            currentData._originalName &&
                            currentData._originalName !==
                                (formData.name || "") && (
                                <p className="mt-1 text-xs text-gray-400">
                                    Исходное значение:{" "}
                                    {currentData._originalName}
                                </p>
                            )}
                        {type !== "artist" &&
                            currentData._originalTitle &&
                            currentData._originalTitle !==
                                (formData.title || "") && (
                                <p className="mt-1 text-xs text-gray-400">
                                    Исходное значение:{" "}
                                    {currentData._originalTitle}
                                </p>
                            )}
                    </div>

                    {/* Bio (Artist only) */}
                    {type === "artist" && (
                        <div>
                            <label
                                htmlFor={fieldId + "-bio"}
                                className="block text-sm font-bold text-white mb-2"
                            >
                                Биография
                            </label>
                            <textarea
                                id={fieldId + "-bio"}
                                value={formData.bio || ""}
                                onChange={(e) =>
                                    handleChange("bio", e.target.value)
                                }
                                rows={6}
                                className="w-full px-4 py-2 bg-surface-elevated border border-white/10 rounded text-white focus:border-white/30 focus:outline-none resize-none"
                            />
                            {currentData._originalBio &&
                                currentData._originalBio !==
                                    (formData.bio || "") && (
                                    <p className="mt-1 text-xs text-gray-400">
                                        Исходное значение:{" "}
                                        {currentData._originalBio.substring(
                                            0,
                                            100,
                                        )}
                                        ...
                                    </p>
                                )}
                        </div>
                    )}

                    {/* Year (Album only) */}
                    {type === "album" && (
                        <div>
                            <label
                                htmlFor={fieldId + "-year"}
                                className="block text-sm font-bold text-white mb-2"
                            >
                                Год выпуска
                            </label>
                            <input
                                id={fieldId + "-year"}
                                type="number"
                                value={formData.year || ""}
                                onChange={(e) =>
                                    handleChange(
                                        "year",
                                        parseInt(e.target.value),
                                    )
                                }
                                className="w-full px-4 py-2 bg-surface-elevated border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                            />
                            {currentData._originalYear &&
                                currentData._originalYear !==
                                    (formData.year || null) && (
                                    <p className="mt-1 text-xs text-gray-400">
                                        Исходное значение:{" "}
                                        {currentData._originalYear}
                                    </p>
                                )}
                        </div>
                    )}

                    {/* Genres */}
                    <div>
                        <label
                            htmlFor={fieldId + "-genres"}
                            className="block text-sm font-bold text-white mb-2"
                        >
                            Жанры
                            <span className="text-xs text-gray-400 ml-2">
                                (через запятую)
                            </span>
                        </label>
                        <input
                            type="text"
                            value={formData.genres?.join(", ") || ""}
                            onChange={(e) =>
                                handleChange(
                                    "genres",
                                    e.target.value
                                        .split(",")
                                        .map((g) => g.trim())
                                        .filter(Boolean),
                                )
                            }
                            id={fieldId + "-genres"}
                            placeholder="Рок, альтернатива, инди"
                            className="w-full px-4 py-2 bg-surface-elevated border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                        />
                        {currentData._originalGenres &&
                            currentData._originalGenres.length > 0 &&
                            JSON.stringify(
                                [...currentData._originalGenres].sort(),
                            ) !==
                                JSON.stringify(
                                    [...(formData.genres || [])].sort(),
                                ) && (
                                <p className="mt-1 text-xs text-gray-400">
                                    Исходное значение:{" "}
                                    {currentData._originalGenres.join(", ")}
                                </p>
                            )}
                    </div>

                    {/* MusicBrainz ID */}
                    <div>
                        <label
                            htmlFor={fieldId + "-mbid"}
                            className="block text-sm font-bold text-white mb-2"
                        >
                            {type === "album"
                                ? "MBID группы релизов"
                                : "MusicBrainz ID"}
                            <span className="text-xs text-gray-400 ml-2">
                                (оставьте пустым для автопоиска)
                            </span>
                        </label>
                        {type === "track" ? (
                            <input
                                type="text"
                                value={formData.mbid || ""}
                                onChange={(e) =>
                                    handleChange("mbid", e.target.value)
                                }
                                id={fieldId + "-mbid"}
                                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                                className={`w-full px-4 py-2 bg-surface-elevated border rounded text-white focus:outline-none font-mono text-sm ${
                                    mbidFieldError
                                        ? "border-red-500/60 focus:border-red-500"
                                        : "border-white/10 focus:border-white/30"
                                }`}
                            />
                        ) : (
                            <div
                                className={
                                    mbidFieldError
                                        ? "rounded border border-red-500/40 bg-red-500/5 p-3"
                                        : undefined
                                }
                            >
                                <MusicBrainzLookup
                                    inputId={fieldId + "-mbid"}
                                    type={type === "album" ? "album" : "artist"}
                                    currentValue={
                                        type === "artist"
                                            ? formData.mbid || ""
                                            : formData.rgMbid || ""
                                    }
                                    currentName={
                                        formData.name || formData.title
                                    }
                                    artistName={artistName}
                                    onSelect={(mbid) =>
                                        handleChange(
                                            type === "artist"
                                                ? "mbid"
                                                : "rgMbid",
                                            mbid,
                                        )
                                    }
                                />
                            </div>
                        )}
                        {mbidFieldError && (
                            <p className="mt-2 text-xs text-red-300">
                                {mbidFieldError}
                            </p>
                        )}
                    </div>

                    {/* Image URL */}
                    <div>
                        <label
                            htmlFor={fieldId + "-image"}
                            className="block text-sm font-bold text-white mb-2"
                        >
                            {type === "artist"
                                ? "Ссылка на изображение исполнителя"
                                : "Ссылка на обложку"}
                            <span className="text-xs text-gray-400 ml-2">
                                (оставьте пустым для автопоиска)
                            </span>
                        </label>
                        <input
                            id={fieldId + "-image"}
                            type="url"
                            value={
                                type === "artist"
                                    ? formData.heroUrl || ""
                                    : formData.coverUrl || ""
                            }
                            onChange={(e) =>
                                handleChange(
                                    type === "artist" ? "heroUrl" : "coverUrl",
                                    e.target.value,
                                )
                            }
                            placeholder="https://..."
                            className="w-full px-4 py-2 bg-surface-elevated border border-white/10 rounded text-white focus:border-white/30 focus:outline-none text-sm"
                        />
                        {type === "artist" &&
                            currentData._originalHeroUrl &&
                            currentData._originalHeroUrl !==
                                (formData.heroUrl || "") && (
                                <p className="mt-1 text-xs text-gray-400 truncate">
                                    Исходное значение:{" "}
                                    {currentData._originalHeroUrl}
                                </p>
                            )}
                        {type === "album" &&
                            currentData._originalCoverUrl &&
                            currentData._originalCoverUrl !==
                                (formData.coverUrl || "") && (
                                <p className="mt-1 text-xs text-gray-400 truncate">
                                    Исходное значение:{" "}
                                    {currentData._originalCoverUrl}
                                </p>
                            )}
                        {/* Image Preview */}
                        {previewImageUrl && (
                            <div className="mt-2">
                                <Image
                                    src={previewImageUrl}
                                    alt="Предпросмотр изображения"
                                    width={128}
                                    height={128}
                                    sizes="128px"
                                    className="w-32 h-32 object-cover rounded"
                                    unoptimized
                                />
                            </div>
                        )}
                    </div>

                    {/* Manual Override Warning */}
                    <div className="bg-yellow-600/10 border border-yellow-600/20 rounded p-4">
                        <p className="text-sm text-yellow-400">
                            <strong>Важно:</strong> Изменённые вручную
                            метаданные не будут перезаписаны при автоматическом
                            дополнении.
                        </p>
                    </div>
                </div>
            </Modal>
            <ConfirmDialog
                isOpen={showResetConfirm}
                onClose={() => setShowResetConfirm(false)}
                onConfirm={confirmReset}
                title="Восстановить метаданные?"
                message="Вернуть все исходные значения? Это действие нельзя отменить."
                confirmText="Восстановить"
                cancelText="Отмена"
                variant="danger"
            />
        </>
    );
}
