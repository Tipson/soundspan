"use client";

import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useImageColor } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";

// Hooks
import { useAudiobookData } from "@/features/audiobook/hooks/useAudiobookData";
import { useAudiobookActions } from "@/features/audiobook/hooks/useAudiobookActions";

// Components
import { AudiobookHero } from "@/features/audiobook/components/AudiobookHero";
import { AudiobookActionBar } from "@/features/audiobook/components/AudiobookActionBar";
import { ChapterList } from "@/features/audiobook/components/ChapterList";

/**
 * Renders the AudiobookDetailPage component.
 */
export default function AudiobookDetailPage() {
    // Data hook
    const {
        audiobookId,
        audiobook,
        isLoading,
        refetch,
        heroImage,
        colorExtractionImage,
        metadata,
    } = useAudiobookData();

    // Extract colors from the hero image (uses token for CORS canvas access)
    const { colors } = useImageColor(colorExtractionImage);

    // Action hooks
    const {
        isThisBookPlaying,
        isPlaying,
        currentTime,
        handlePlayPause,
        handleMarkAsCompleted,
        handleResetProgress,
        seekToChapter,
    } = useAudiobookActions(audiobookId, audiobook ?? null, refetch);

    // Loading state
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!audiobook) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-content-secondary">Аудиокнига не найдена</p>
            </div>
        );
    }

    // Clean up description - strip HTML and clean whitespace
    const cleanDescription = audiobook.description
        ? audiobook.description
              .replace(/<[^>]*>/g, " ")
              .replace(/\s+/g, " ")
              .trim()
        : null;

    const showDescription =
        cleanDescription &&
        !cleanDescription.match(/^(Read by|Narrated by):/i) &&
        cleanDescription.length > 20;

    return (
        <div className="min-h-screen flex flex-col">
            <AudiobookHero
                audiobook={audiobook}
                heroImage={heroImage}
                colors={colors}
                metadata={metadata}
                formatTime={formatTime}
            >
                <AudiobookActionBar
                    audiobook={audiobook}
                    isThisBookPlaying={isThisBookPlaying}
                    isPlaying={isPlaying}
                    currentTime={currentTime}
                    onPlayPause={handlePlayPause}
                    onResetProgress={handleResetProgress}
                    onMarkAsCompleted={handleMarkAsCompleted}
                    formatTime={formatTime}
                />
            </AudiobookHero>

            {/* Main Content */}
            <div className="relative flex-1">
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        background: colors
                            ? `linear-gradient(to bottom, ${colors.vibrant}15 0%, ${colors.vibrant}08 15%, ${colors.darkVibrant}05 30%, transparent 50%)`
                            : "transparent",
                    }}
                />

                <div className="relative mx-auto max-w-[1800px] space-y-7 px-4 py-7 sm:px-6 lg:px-8">
                    <ChapterList
                        kind={audiobook.sectionKind}
                        sections={audiobook.sections}
                        sectionsPlayable={audiobook.sectionsPlayable}
                        onSeekToSection={seekToChapter}
                        formatTime={formatTime}
                    />

                    {/* Description / About */}
                    {showDescription && (
                        <section>
                            <h2 className="mb-4 text-xl font-semibold text-content sm:text-2xl">
                                Описание
                            </h2>
                            <div className="rounded-[14px] bg-surface-raised p-4 sm:p-5">
                                <p className="max-w-[70ch] text-sm leading-7 text-content-secondary [overflow-wrap:anywhere]">
                                    {cleanDescription}
                                </p>
                            </div>
                        </section>
                    )}

                    {/* Series info */}
                    {audiobook.series && (
                        <section>
                            <h2 className="mb-4 text-xl font-semibold text-content sm:text-2xl">
                                Серия
                            </h2>
                            <div className="flex flex-wrap items-center gap-3 text-sm">
                                <span className="text-brand font-medium">
                                    {audiobook.series.name}
                                </span>
                                <span className="text-content-muted">•</span>
                                <span className="text-content-secondary">
                                    Книга {audiobook.series.sequence}
                                </span>
                            </div>
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
}
