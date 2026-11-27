"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import type { TrackAudioVersions } from "@/lib/api/media";
import {
    trackAudioStreamUrl,
    type TrackAudioTarget,
} from "@/lib/audio/trackAudioVersions";
import { Button } from "./Button";
import { Modal } from "./Modal";

interface Props {
    target: TrackAudioTarget;
    trackName: string;
    onClose(): void;
}

/** Manage one alternate recording without changing the selected catalog row. */
export function TrackAudioVersionModal({ target, trackName, onClose }: Props) {
    const signal = useRef<AbortController | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const fileId = useId();
    const { source, trackId } = target;
    const [versions, setVersions] = useState<TrackAudioVersions | null>(null);
    const [file, setFile] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [loadRevision, setLoadRevision] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        signal.current = controller;
        void api
            .getTrackAudioVersions({ source, trackId }, controller.signal)
            .then(
                (result) => {
                    if (!controller.signal.aborted) setVersions(result);
                },
                () => {
                    if (!controller.signal.aborted)
                        setError("Не удалось проверить версии трека.");
                },
            );
        return () => {
            controller.abort();
            signal.current = null;
        };
    }, [source, trackId, loadRevision]);

    async function update(
        operation: (signal: AbortSignal) => Promise<TrackAudioVersions>,
        failure: string,
        onSuccess?: () => void,
    ) {
        const current = signal.current?.signal;
        if (busy || !current || current.aborted) return;
        setBusy(true);
        setError("");
        try {
            const result = await operation(current);
            if (!current.aborted) {
                setVersions(result);
                onSuccess?.();
            }
        } catch {
            if (!current.aborted) setError(failure);
        } finally {
            if (!current.aborted) setBusy(false);
        }
    }

    function clearFile() {
        if (fileInput.current) fileInput.current.value = "";
        setFile(null);
    }

    const draft = trackAudioStreamUrl(versions?.draftId);
    const published = trackAudioStreamUrl(versions?.publishedId);
    if (typeof document === "undefined") return null;

    // The glass player dock creates a containing block for fixed descendants.
    const dialog = (
        <Modal isOpen onClose={onClose} title="Полная версия трека">
            <div className="space-y-4">
                <p className="break-words font-semibold">{trackName}</p>
                {versions && (
                    <form
                        className="space-y-2"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (!file) return;
                            if (
                                file.size === 0 ||
                                file.size > 16 * 1024 * 1024
                            ) {
                                setError(
                                    "Выберите непустой MP3 размером до 16 МиБ.",
                                );
                                return;
                            }
                            void update(
                                (signal) =>
                                    api.uploadTrackAudio(target, file, signal),
                                "Не удалось загрузить. Проверьте файл и повторите попытку.",
                                clearFile,
                            );
                        }}
                    >
                        <label htmlFor={fileId} className="block">
                            Аудиофайл MP3 до 16 МиБ
                        </label>
                        <input
                            ref={fileInput}
                            id={fileId}
                            className="block max-w-full"
                            type="file"
                            accept=".mp3,audio/mpeg"
                            disabled={busy}
                            onChange={(event) =>
                                setFile(event.target.files?.[0] ?? null)
                            }
                        />
                        <Button type="submit" disabled={busy || !file}>
                            Загрузить черновик
                        </Button>
                        {file && (
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={busy}
                                onClick={clearFile}
                            >
                                Сбросить выбор файла
                            </Button>
                        )}
                    </form>
                )}
                {draft && versions?.draftId && (
                    <section className="space-y-2" aria-label="Черновик">
                        <p>Черновик</p>
                        <audio
                            className="w-full"
                            controls
                            preload="none"
                            src={draft}
                            aria-label="Прослушать черновик"
                        />
                        <Button
                            type="button"
                            disabled={busy || file !== null}
                            onClick={() => {
                                const id = versions.draftId!;
                                void update(
                                    (signal) =>
                                        api.publishTrackAudio(
                                            target,
                                            id,
                                            signal,
                                        ),
                                    "Не удалось опубликовать. Откройте окно заново. Если черновик недоступен, загрузите MP3 заново.",
                                );
                            }}
                        >
                            Опубликовать для всех
                        </Button>
                    </section>
                )}
                {published && versions?.publishedId && (
                    <section
                        className="space-y-2"
                        aria-label="Опубликованная версия"
                    >
                        <p>Без цензуры · опубликовано</p>
                        <audio
                            className="w-full"
                            controls
                            preload="none"
                            src={published}
                            aria-label="Прослушать опубликованную версию"
                        />
                        <Button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                const id = versions.publishedId!;
                                void update(
                                    (signal) =>
                                        api.withdrawTrackAudio(
                                            target,
                                            id,
                                            signal,
                                        ),
                                    "Не удалось снять с публикации. Откройте окно заново и повторите попытку.",
                                );
                            }}
                        >
                            Снять с публикации
                        </Button>
                    </section>
                )}
                {busy && <p role="status">Сохраняем изменения…</p>}
                {!versions && !error && <p role="status">Проверяем версии…</p>}
                {error && <p role="alert">{error}</p>}
                {!versions && error && (
                    <Button
                        type="button"
                        onClick={() => {
                            setError("");
                            setLoadRevision((value) => value + 1);
                        }}
                    >
                        Повторить
                    </Button>
                )}
            </div>
        </Modal>
    );
    return createPortal(dialog, document.body);
}
