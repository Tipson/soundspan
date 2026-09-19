"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useFeatures } from "@/lib/features-context";
import { isListenTogetherActiveOrPending } from "@/lib/listen-together-session";
import {
    toAudiusPlaybackTrack,
    type AudiusCatalogTrack,
} from "@/lib/audio/audiusPlayback";

/** Explicit exploration shelf; never blends independent uploads into original-recording matches. */
export function AudiusSearchPanel({ query }: { query: string }) {
    const { audius: enabled } = useFeatures();
    const { playTracks } = useAudioControls();
    const [tracks, setTracks] = useState<AudiusCatalogTrack[]>([]);
    const [status, setStatus] = useState("idle");
    const [message, setMessage] = useState("");
    const pending = useRef<AbortController | null>(null);
    useEffect(() => () => pending.current?.abort(), []);

    async function search() {
        if (pending.current) return;
        const controller = new AbortController();
        pending.current = controller;
        setStatus("loading");
        setMessage("");
        try {
            const results = await api.searchAudius(
                query.trim(),
                controller.signal,
            );
            if (controller.signal.aborted) return;
            setTracks(results);
            setStatus("ready");
            if (results.length === 0)
                setMessage(
                    "В Audius нет доступных полных треков по этому запросу.",
                );
        } catch (error) {
            if (controller.signal.aborted) return;
            setStatus("error");
            setMessage(
                typeof error === "object" &&
                    error !== null &&
                    "status" in error &&
                    error.status === 404
                    ? "Audius не включён администратором. Основной поиск продолжает работать."
                    : "Audius сейчас недоступен. Попробуйте позже; другие источники не затронуты.",
            );
        } finally {
            if (pending.current === controller) pending.current = null;
        }
    }

    function play(index: number) {
        if (isListenTogetherActiveOrPending()) {
            setMessage(
                "Audius доступен для личного прослушивания. Сначала выйдите из совместной сессии.",
            );
            return;
        }
        playTracks(tracks.map(toAudiusPlaybackTrack), index);
    }

    if (!enabled || !query.trim() || query.trim().length > 200) return null;
    return (
        <section
            aria-label="Независимый каталог Audius"
            className="relative rounded-2xl border border-line-strong bg-surface/50 p-4 sm:p-5"
        >
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-lg font-bold text-content">
                        Audius · независимая сцена
                    </h2>
                    <p className="mt-1 text-sm text-content-muted">
                        Отдельные авторские загрузки, лайвы и ремиксы. Не замена
                        оригиналам из основного поиска.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void search()}
                    disabled={status === "loading"}
                    className="min-h-11 rounded-full border border-line-strong px-4 text-sm font-semibold text-content hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
                >
                    {status === "loading"
                        ? "Ищем в Audius…"
                        : "Искать в Audius"}
                </button>
            </div>
            {message ? (
                <p
                    role="status"
                    className="mt-3 text-sm text-content-secondary"
                >
                    {message}
                </p>
            ) : null}
            {tracks.length > 0 ? (
                <ul className="mt-4 divide-y divide-line-subtle">
                    {tracks.map((track, index) => (
                        <li
                            key={track.id}
                            className="flex items-center gap-3 py-2"
                        >
                            <button
                                type="button"
                                onClick={() => play(index)}
                                aria-label={`Слушать ${track.title} — ${track.artist} в Audius`}
                                className="min-h-11 min-w-0 flex-1 rounded-lg p-2 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand"
                            >
                                <span className="block truncate font-semibold text-content">
                                    {track.title}
                                </span>
                                <span className="block truncate text-sm text-content-muted">
                                    {track.artist} ·{" "}
                                    {Math.floor(track.durationSeconds / 60)}:
                                    {String(
                                        Math.floor(track.durationSeconds % 60),
                                    ).padStart(2, "0")}
                                </span>
                            </button>
                            <a
                                href={track.attributionUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Открыть ${track.title} в Audius`}
                                className="shrink-0 rounded-full border border-line-strong px-3 py-2 text-xs text-content-secondary focus-visible:outline-2 focus-visible:outline-brand"
                            >
                                Audius ↗
                            </a>
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
