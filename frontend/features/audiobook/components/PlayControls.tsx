"use client";

import { Button } from "@/components/ui/Button";
import { Play, Pause, Book } from "lucide-react";
import type { Audiobook } from "../types";

interface PlayControlsProps {
    audiobook: Audiobook;
    isThisBookPlaying: boolean;
    isPlaying: boolean;
    currentTime: number;
    onPlayPause: () => void;
    formatTime: (seconds: number) => string;
}

/**
 * Renders the PlayControls component.
 */
export function PlayControls({
    audiobook,
    isThisBookPlaying,
    isPlaying,
    currentTime,
    onPlayPause,
    formatTime,
}: PlayControlsProps) {
    const progress = audiobook.progress;
    const hasProgress = (progress?.progress ?? 0) > 0;
    const isFinished = progress?.isFinished;

    return (
        <section>
            <div className="flex flex-col sm:flex-row gap-4 items-center justify-center">
                <Button
                    variant="primary"
                    className="min-h-12 rounded-[10px] px-6 motion-reduce:transition-none"
                    onClick={onPlayPause}
                >
                    {isThisBookPlaying && isPlaying ? (
                        <>
                            <Pause className="w-6 h-6 mr-2" />
                            <span className="font-semibold">Пауза</span>
                        </>
                    ) : (
                        <>
                            <Play className="w-6 h-6 mr-2 fill-current" />
                            <span className="font-semibold">
                                {hasProgress && !isFinished
                                    ? "Продолжить"
                                    : "Слушать"}
                            </span>
                        </>
                    )}
                </Button>

                {hasProgress && !isFinished && (
                    <div className="text-center sm:text-left">
                        <div className="text-sm text-content-secondary">
                            Продолжить прослушивание
                        </div>
                        <div className="text-content font-medium">
                            {formatTime(
                                isThisBookPlaying
                                    ? currentTime
                                    : (progress?.currentTime ?? 0),
                            )}{" "}
                            / {formatTime(audiobook.duration)}
                        </div>
                        <div className="w-48 h-1 bg-surface-elevated rounded-full mt-2">
                            <div
                                className="h-full bg-brand rounded-full transition-all duration-300"
                                style={{
                                    width: `${
                                        isThisBookPlaying
                                            ? (currentTime /
                                                  audiobook.duration) *
                                              100
                                            : (progress?.progress ?? 0)
                                    }%`,
                                }}
                            />
                        </div>
                    </div>
                )}

                {isFinished && (
                    <div className="flex items-center gap-2 text-success">
                        <Book className="w-5 h-5" />
                        <span className="font-medium">Прослушано</span>
                    </div>
                )}
            </div>
        </section>
    );
}
