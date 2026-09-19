"use client";

import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/audio-state-context";

const reasons = [
    ["wrong_version", "Не та версия записи"],
    ["no_sound", "Нет звука"],
    ["interruption", "Музыка прервалась"],
] as const;

/** Manual reporting for the current player track; choosing a reason captures its live engine state. */
export function PlaybackReport({
    track,
}: {
    track: Pick<Track, "id" | "title" | "artist">;
}) {
    const [status, setStatus] = useState<
        "stored" | "memory" | "rejected" | null
    >(null);
    const submitted = useRef(false);
    const active = useRef(true);
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
        };
    }, []);
    return (
        <details className="border-t border-line px-3 py-2 text-sm text-content-body">
            <summary className="cursor-pointer py-2">
                Сообщить о проблеме
            </summary>
            <p className="mb-2 text-xs text-content-muted">
                Выберите причину — администратор получит трек, позицию и
                состояние плеера и сети.
            </p>
            {reasons.map(([reason, label]) => (
                <button
                    key={reason}
                    type="button"
                    disabled={status === "stored" || status === "memory"}
                    className="min-h-11 w-full rounded-xl px-3 py-2 text-left hover:bg-surface-hover disabled:opacity-50"
                    onClick={() => {
                        if (submitted.current) return;
                        submitted.current = true;
                        void import("@/lib/audio-engine/audioPlaybackOrchestratorRuntime")
                            .then(({ queueUserPlaybackReport }) => {
                                if (!active.current) return;
                                const result = queueUserPlaybackReport({
                                    reason,
                                    reportTrackId: track.id,
                                    reportTitle: track.title,
                                    reportArtist: track.artist.name,
                                });
                                setStatus(result);
                                if (result === "rejected")
                                    submitted.current = false;
                            })
                            .catch(() => {
                                if (!active.current) return;
                                submitted.current = false;
                                setStatus("rejected");
                            });
                    }}
                >
                    {label}
                </button>
            ))}
            {status && (
                <p role="status" className="mt-2 text-xs text-content-muted">
                    {status === "stored"
                        ? "Обращение сохранено в очередь. Отправим при доступном интернете."
                        : status === "memory"
                          ? "Обращение в очереди этой вкладки. Не закрывайте приложение до подключения к сети."
                          : "Не удалось сохранить обращение. Проверьте вход в аккаунт и повторите."}
                </p>
            )}
        </details>
    );
}
