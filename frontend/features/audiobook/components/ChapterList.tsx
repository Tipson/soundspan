"use client";

import { Card } from "@/components/ui/Card";
import type { AudiobookSection, AudiobookSectionKind } from "../types";

interface ChapterListProps {
    kind: AudiobookSectionKind;
    sections: AudiobookSection[];
    sectionsPlayable: boolean;
    onSeekToSection: (startTime: number) => void;
    formatTime: (seconds: number) => string;
}

/**
 * Renders the ChapterList component.
 */
export function ChapterList({
    kind,
    sections,
    sectionsPlayable,
    onSeekToSection,
    formatTime,
}: ChapterListProps) {
    if (kind === "none" || !sectionsPlayable || sections.length === 0) {
        return null;
    }

    const heading = kind === "parts" ? "Части" : "Главы";

    return (
        <section>
            <h2 className="mb-4 text-xl font-semibold text-content sm:text-2xl">
                {heading}
            </h2>
            <Card className="rounded-[14px] p-2">
                <div className="space-y-1">
                    {sections.map((section) => (
                        <button
                            key={section.index}
                            onClick={() =>
                                onSeekToSection(section.startSeconds)
                            }
                            className="group min-h-11 w-full rounded-[10px] p-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                        >
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <span className="text-sm text-content-muted mr-2">
                                        {section.index + 1}.
                                    </span>
                                    <span className="text-sm font-medium text-content [overflow-wrap:anywhere]">
                                        {section.title}
                                    </span>
                                </div>
                                <span className="shrink-0 text-xs tabular-nums text-content-muted">
                                    {formatTime(section.startSeconds)}
                                </span>
                            </div>
                        </button>
                    ))}
                </div>
            </Card>
        </section>
    );
}
