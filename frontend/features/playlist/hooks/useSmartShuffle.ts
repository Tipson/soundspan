"use client";

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { toast } from "sonner";
import { api, type PlaylistDetailResponse } from "@/lib/api";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import {
    reservePlaybackIntent,
    getPlaybackIntentGeneration,
} from "@/lib/audio-engine/playbackAdvanceOrigin";
import {
    readSmartShuffleLineage,
    disableSmartShufflePlayback,
    SMART_SHUFFLE_POOL_LIMIT,
} from "@/lib/audio/finiteSmartShuffle";
import { isListenTogetherActiveOrPending } from "@/lib/listen-together-session";
import {
    getCollectionPlaybackGeneration,
    markCollectionPlayback,
} from "@/lib/collectionPlayback";
import { prepareSmartShuffle } from "../lib/prepareSmartShuffle";

/** Opt-in finite preparation; uses the sole player, queue checkpoint and owner admission. */
export function useSmartShuffle(
    playlistId: string,
    cachedSnapshot: PlaylistDetailResponse | undefined,
) {
    const state = useAudioState();
    const controls = useAudioControls();
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const mounted = useRef(true);
    const request = useRef<{
        controller: AbortController;
        revision: number;
        sourceVersion: string;
    } | null>(null);
    const sourceVersion = useMemo(
        () =>
            JSON.stringify([
                playlistId,
                cachedSnapshot?.name,
                cachedSnapshot?.totalItemCount,
                cachedSnapshot?.items.map((item) => [item.id, item.sort]),
                cachedSnapshot?.pendingCount,
            ]),
        [playlistId, cachedSnapshot],
    );
    const latest = useRef({ state, controls, cachedSnapshot, sourceVersion });
    useLayoutEffect(() => {
        latest.current = { state, controls, cachedSnapshot, sourceVersion };
    });
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            request.current?.controller.abort();
            request.current = null;
        };
    }, []);
    useEffect(() => {
        if (
            request.current &&
            (state.getQueueRevision() !== request.current.revision ||
                sourceVersion !== request.current.sourceVersion)
        ) {
            request.current.controller.abort();
            request.current = null;
            setBusy(false);
        }
    }, [state.queue, state.currentIndex, state, sourceVersion]);

    const metadata = state.queue.flatMap((item) => {
        const value = readSmartShuffleLineage(
            (item as { smartShuffle?: unknown }).smartShuffle,
        );
        return value?.playlistId === playlistId ? [value] : [];
    });
    const active =
        metadata.length > 0 &&
        metadata.every(
            (row) => row.enabled && row.sessionId === metadata[0].sessionId,
        );

    const toggle = useCallback(async () => {
        if (request.current) {
            request.current.controller.abort();
            request.current = null;
            setBusy(false);
            return;
        }
        const before = latest.current;
        if (
            before.cachedSnapshot?.isOwner !== true ||
            isListenTogetherActiveOrPending()
        )
            return;
        const feedback = before.state.recommendationFeedback;
        const permission = feedback.captureAdmission?.();
        if (!permission || !feedback.isPreparationCurrent?.(permission)) return;
        const session = before.state.queue.flatMap((item) => {
            const value = readSmartShuffleLineage(
                (item as { smartShuffle?: unknown }).smartShuffle,
            );
            return value?.playlistId === playlistId && value.enabled
                ? [value]
                : [];
        });
        if (
            session.length &&
            session.every((row) => row.sessionId === session[0].sessionId)
        ) {
            const capture = {
                queue: before.state.queue,
                currentIndex: before.state.currentIndex,
                isShuffle: before.state.isShuffle,
                shuffleIndices: before.state.shuffleIndices,
            };
            const next = disableSmartShufflePlayback(
                capture,
                session[0].sessionId,
            );
            const auth = api.getSessionGeneration();
            before.state.setQueue(next.queue);
            before.state.setCurrentIndex(next.currentIndex);
            before.state.setShuffleIndices(next.shuffleIndices);
            const revision = before.state.getQueueRevision();
            setNotice(
                "Будущие находки выключены. Текущий трек и история сохранены.",
            );
            toast.info("Умный shuffle выключен", {
                action: {
                    label: "Отменить",
                    onClick: () => {
                        const current = latest.current;
                        if (
                            !mounted.current ||
                            api.getSessionGeneration() !== auth ||
                            current.state.getQueueRevision() !== revision ||
                            isListenTogetherActiveOrPending() ||
                            !permission ||
                            !current.state.recommendationFeedback.isPreparationCurrent?.(
                                permission,
                            )
                        )
                            return;
                        current.state.setQueue(capture.queue);
                        current.state.setCurrentIndex(capture.currentIndex);
                        current.state.setShuffleIndices(capture.shuffleIndices);
                        setNotice("Умный shuffle восстановлен.");
                    },
                },
            });
            return;
        }
        if (
            !permission ||
            !feedback.isPreparationCurrent?.(permission) ||
            !feedback.readmitCandidates
        ) {
            toast.error(
                "Не удалось проверить доступность находок. Повторите попытку.",
            );
            return;
        }
        const auth = api.getSessionGeneration(),
            revision = before.state.getQueueRevision(),
            version = before.sourceVersion;
        const intent = reservePlaybackIntent(),
            controller = new AbortController(),
            ticket = { controller, revision, sourceVersion: version };
        request.current = ticket;
        setBusy(true);
        setNotice(null);
        const current = () =>
            mounted.current &&
            request.current === ticket &&
            !controller.signal.aborted &&
            api.getSessionGeneration() === auth &&
            latest.current.state.getQueueRevision() === revision &&
            latest.current.sourceVersion === version &&
            getPlaybackIntentGeneration() === intent &&
            !isListenTogetherActiveOrPending() &&
            feedback.isPreparationCurrent?.(permission) === true;
        try {
            const result = await prepareSmartShuffle({
                playlistId,
                seed: crypto.getRandomValues(new Uint32Array(1))[0],
                sessionId: crypto.randomUUID(),
                signal: controller.signal,
                isCurrent: current,
                online:
                    typeof navigator === "undefined" ||
                    navigator.onLine !== false,
                cachedSnapshot: before.cachedSnapshot,
                loadSnapshot: () =>
                    api.getPlaylist(playlistId, controller.signal),
                loadPool: async () =>
                    (
                        await api.getRadioTracks(
                            "playlist",
                            playlistId,
                            SMART_SHUFFLE_POOL_LIMIT,
                            controller.signal,
                        )
                    ).tracks,
                admit: async (refs, signal) => {
                    const result = await feedback.readmitCandidates!(
                        refs,
                        signal,
                    );
                    return feedback.isPreparationCurrent?.(result.capture)
                        ? result
                        : { status: "superseded" };
                },
            });
            if (!current()) return;
            if (result.status !== "ready") {
                if (result.status === "queue-limit") {
                    const message =
                        "Предпросмотр доступен до 99 ваших треков: в очереди нужен слот для находки. Плейлист не сокращён; обычное воспроизведение доступно.";
                    setNotice(message);
                    toast.info(message);
                }
                if (result.status === "invalid-snapshot")
                    toast.error(
                        "Нужен полный доступный плейлист — предпросмотр не запущен.",
                    );
                return;
            }
            const generation = getCollectionPlaybackGeneration();
            before.controls.playTracks(result.tracks, 0, false, {
                replaceQueue: true,
                preserveOrder: true,
            });
            markCollectionPlayback(`playlist:${playlistId}`, generation);
            const inserted = result.tracks.filter(
                (track) => track.smartShuffle?.kind === "injected",
            ).length;
            const ownCount = result.tracks.length - inserted;
            setNotice(
                inserted
                    ? ownCount < 3
                        ? "Одна находка в конце. Плейлист не изменён."
                        : "Одна находка после трёх ваших треков. Плейлист не изменён."
                    : "Находки сейчас недоступны — играют только ваши треки.",
            );
        } catch {
            if (current())
                toast.error(
                    "Не удалось подготовить умный shuffle. Очередь не изменена.",
                );
        } finally {
            if (mounted.current && request.current === ticket) {
                request.current = null;
                setBusy(false);
            }
        }
    }, [playlistId]);
    return { active, busy, notice, onToggle: () => void toggle() };
}
