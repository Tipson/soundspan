"use client";

import { useCallback, useMemo, useRef, useLayoutEffect } from "react";
import {
    useAudioControls,
    useAudioState,
    usePlaybackStatus,
} from "@/lib/audio-context";
import { usePlaybackProgress } from "@/lib/audio-playback-context";
import { useToast } from "@/lib/toast-context";
import { api } from "@/lib/api";
import type { Audiobook } from "../types";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

import {
    captureAudiobookProgressWrite,
    type AudiobookProgressWrite,
} from "@/lib/audiobookProgressWrites";
import {
    getAuthRuntimeGeneration,
    isCurrentAuthRuntime,
} from "@/lib/auth-runtime-generation";

/**
 * Executes useAudiobookActions.
 */
export function useAudiobookActions(
    audiobookId: string,
    audiobook: Audiobook | null,
    refetch: () => void,
) {
    const { currentAudiobook, playbackType } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    // Consumers display the live position, so this hook is a clock consumer.
    const { currentTime } = usePlaybackProgress();
    const { pause, resume, playAudiobook, updateCurrentTime, seek } =
        useAudioControls();
    const { setCurrentAudiobook, setPlaybackType } = useAudioState();
    const { toast } = useToast();
    const authGeneration = getAuthRuntimeGeneration();
    const owner = useMemo(
        () => ({
            audiobookId,
            id: currentAudiobook?.id,
            playbackType,
            authGeneration,
        }),
        [audiobookId, currentAudiobook?.id, playbackType, authGeneration],
    );
    const currentOwner = useRef<object | null>(owner);
    useLayoutEffect(() => {
        currentOwner.current = owner;
        return () => {
            if (currentOwner.current === owner) currentOwner.current = null;
        };
    }, [owner]);

    const pendingResetCleanup = useRef<AudiobookProgressWrite | null>(null);
    useLayoutEffect(() => {
        const intent = pendingResetCleanup.current;
        if (!intent) return;
        pendingResetCleanup.current = null;
        // Observe the committed selection before clearing its type or clock.
        // Another selection may have been queued before the reset response.
        if (
            intent.isCurrent() &&
            !currentAudiobook &&
            playbackType === "audiobook" &&
            !isPlaying
        ) {
            setPlaybackType(null);
            updateCurrentTime(0);
        }
    });

    const isThisBookPlaying =
        currentAudiobook?.id === audiobookId && playbackType === "audiobook";

    const handlePlayPause = useCallback(() => {
        if (!audiobook) return;

        // If no audiobook playing, or a DIFFERENT audiobook is playing, start this one
        if (!currentAudiobook || currentAudiobook.id !== audiobookId) {
            playAudiobook(audiobook);
        } else if (isPlaying) {
            // Same audiobook is playing - pause it
            pause();
        } else {
            // Same audiobook is paused - resume it
            resume();
        }
    }, [
        audiobook,
        audiobookId,
        currentAudiobook,
        isPlaying,
        pause,
        resume,
        playAudiobook,
    ]);

    const handleMarkAsCompleted = useCallback(async () => {
        if (
            !audiobook ||
            !isCurrentAuthRuntime(authGeneration) ||
            currentOwner.current !== owner
        )
            return;
        const intent = captureAudiobookProgressWrite(audiobookId, true);

        try {
            const isCurrentlyPlaying =
                currentAudiobook?.id === audiobookId &&
                playbackType === "audiobook";

            if (isCurrentlyPlaying && isPlaying) {
                pause();
            }

            const saved = await intent.run(() =>
                api.updateAudiobookProgress(
                    audiobookId,
                    audiobook.duration || 0,
                    audiobook.duration || 0,
                    true,
                ),
            );
            if (!saved || !intent.isCurrent() || currentOwner.current !== owner)
                return;

            if (currentAudiobook?.id === audiobookId) {
                const finalDuration =
                    audiobook.duration || currentAudiobook.duration || 0;
                setCurrentAudiobook((previous) => {
                    if (
                        !intent.isCurrent() ||
                        currentOwner.current !== owner ||
                        previous?.id !== audiobookId
                    )
                        return previous;
                    return {
                        ...previous,
                        progress: {
                            currentTime: finalDuration,
                            progress: finalDuration > 0 ? 100 : 0,
                            isFinished: true,
                            lastPlayedAt: new Date(),
                        },
                    };
                });
            }

            toast.success("Отмечено как прослушанное");
            refetch();
        } catch (error) {
            if (
                !intent.isCurrent() ||
                !isCurrentAuthRuntime(authGeneration) ||
                currentOwner.current !== owner
            )
                return;
            sharedFrontendLogger.error("Failed to mark as completed:", error);
            toast.error("Не удалось отметить как прослушанное");
        }
    }, [
        audiobook,
        audiobookId,
        currentAudiobook,
        playbackType,
        isPlaying,
        pause,
        setCurrentAudiobook,
        toast,
        refetch,
        owner,
        authGeneration,
    ]);

    const handleResetProgress = useCallback(async () => {
        if (
            !isCurrentAuthRuntime(authGeneration) ||
            currentOwner.current !== owner
        )
            return;
        const intent = captureAudiobookProgressWrite(audiobookId, true);
        try {
            const isCurrentlyPlaying =
                currentAudiobook?.id === audiobookId &&
                playbackType === "audiobook";

            if (isCurrentlyPlaying && isPlaying) {
                pause();
            }

            const saved = await intent.run(() =>
                api.deleteAudiobookProgress(audiobookId),
            );
            if (!saved || !intent.isCurrent() || currentOwner.current !== owner)
                return;

            if (currentAudiobook?.id === audiobookId) {
                pendingResetCleanup.current = intent;
                setCurrentAudiobook((previous) =>
                    intent.isCurrent() &&
                    currentOwner.current === owner &&
                    previous?.id === audiobookId
                        ? null
                        : previous,
                );
            }

            toast.success("Прогресс сброшен");
            refetch();
        } catch (error) {
            if (
                !intent.isCurrent() ||
                !isCurrentAuthRuntime(authGeneration) ||
                currentOwner.current !== owner
            )
                return;
            sharedFrontendLogger.error("Failed to reset progress:", error);
            toast.error("Не удалось сбросить прогресс");
        }
    }, [
        audiobookId,
        currentAudiobook,
        playbackType,
        isPlaying,
        pause,
        setCurrentAudiobook,
        toast,
        refetch,
        owner,
        authGeneration,
    ]);

    const seekToChapter = useCallback(
        (startTime: number) => {
            if (!audiobook) return;

            // If this book is not currently loaded, start playback first
            if (!isThisBookPlaying) {
                playAudiobook(audiobook);
            }

            // Perform an actual player seek so audio jumps to the chapter
            seek(startTime);
        },
        [audiobook, isThisBookPlaying, playAudiobook, seek],
    );

    return {
        isThisBookPlaying,
        isPlaying,
        currentTime,
        handlePlayPause,
        handleMarkAsCompleted,
        handleResetProgress,
        seekToChapter,
    };
}
