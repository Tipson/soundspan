"use client";

import { memo, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ListMusic, Trash2 } from "lucide-react";
import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";
import {
    resolveQueueCenteringBehavior,
    resolveQueueCenteringIndex,
} from "@/lib/overlay-queue-centering";
import { buildTabTransitionProps } from "./overlayTabMotion";
import {
    OverlayQueueEpisodeRow,
    OverlayQueueTrackRow,
} from "./OverlayQueueRows";
import { pluralRu, ru } from "@/lib/i18n/ru";

/**
 * Rows rendered on the first pass before react-virtuoso measures the
 * viewport; keeps happy-dom component tests and first paint windowed.
 */
const INITIAL_WINDOW_COUNT = 20;
const ESTIMATED_ROW_HEIGHT = 60;

interface OverlayQueueTabProps {
    queueTracks: QueueItem[];
    currentIndex: number;
    onPlayFromQueue: (index: number) => void;
    onRemoveFromQueue: (index: number) => void;
    onClearQueue: () => void;
}

/**
 * The overlay drawer's Up Next tab (GH #787): windowed queue list that
 * follows playback until the listener interacts with the list. Manual
 * browsing stays in place until an explicit return to the playing row.
 */
export const OverlayQueueTab = memo(function OverlayQueueTab({
    queueTracks,
    currentIndex,
    onPlayFromQueue,
    onRemoveFromQueue,
    onClearQueue,
}: OverlayQueueTabProps) {
    const shouldReduceMotion = useReducedMotion();
    const virtuosoRef = useRef<VirtuosoHandle | null>(null);
    const isFirstRevealRef = useRef(true);
    const previousIndexRef = useRef<number | null>(null);
    const isBrowsingRef = useRef(false);
    const [isBrowsing, setIsBrowsing] = useState(false);

    const preserveBrowsingPosition = () => {
        if (isBrowsingRef.current) return;
        isBrowsingRef.current = true;
        setIsBrowsing(true);
    };

    const returnToCurrentTrack = () => {
        isBrowsingRef.current = false;
        setIsBrowsing(false);
        // An explicit return may span thousands of rows: jump directly
        // instead of animating through the whole virtual list.
        virtuosoRef.current?.scrollToIndex({
            index: resolveQueueCenteringIndex(currentIndex, queueTracks.length),
            align: "center",
            behavior: "auto",
        });
    };

    useEffect(() => {
        const isFirstReveal = isFirstRevealRef.current;
        const indexChanged =
            previousIndexRef.current !== null &&
            previousIndexRef.current !== currentIndex;
        isFirstRevealRef.current = false;
        previousIndexRef.current = currentIndex;

        const behavior = resolveQueueCenteringBehavior({
            isFirstReveal,
            indexChanged,
            shouldReduceMotion: !!shouldReduceMotion,
            queueLength: queueTracks.length,
        });
        // The reveal itself is handled by initialTopMostItemIndex below.
        if (!behavior || isFirstReveal || isBrowsingRef.current) return;
        virtuosoRef.current?.scrollToIndex({
            index: resolveQueueCenteringIndex(currentIndex, queueTracks.length),
            align: "center",
            behavior,
        });
    }, [currentIndex, queueTracks.length, shouldReduceMotion]);

    return (
        <motion.section
            key="queue"
            {...buildTabTransitionProps(shouldReduceMotion)}
            className="h-full overflow-hidden flex flex-col"
        >
            <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-2">
                <div className="flex min-h-11 items-center gap-2">
                    <ListMusic
                        className="h-4 w-4 shrink-0 text-brand-hover"
                        aria-hidden="true"
                    />
                    {isBrowsing && queueTracks.length > 0 ? (
                        <button
                            type="button"
                            onClick={returnToCurrentTrack}
                            aria-label="Вернуться к текущему треку"
                            className="min-h-11 whitespace-nowrap rounded-lg px-1 text-sm font-semibold text-brand-hover hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        >
                            К треку
                        </button>
                    ) : (
                        <h2 className="text-sm font-semibold text-white">
                            Далее
                        </h2>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    {queueTracks.length > 0 && (
                        <button
                            type="button"
                            onClick={onClearQueue}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg text-xs text-gray-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                            title={ru.player.clearQueue}
                            aria-label={ru.player.clearQueue}
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            <span className="hidden sm:inline">
                                Очистить очередь
                            </span>
                        </button>
                    )}
                    <span className="text-xs text-gray-400">
                        {queueTracks.length}{" "}
                        {pluralRu(queueTracks.length, [
                            "элемент",
                            "элемента",
                            "элементов",
                        ])}
                    </span>
                </div>
            </div>

            {queueTracks.length === 0 ? (
                <div className="flex min-h-0 flex-1 items-center justify-center px-4">
                    <p className="text-sm text-gray-400">
                        {ru.player.emptyQueue}
                    </p>
                </div>
            ) : (
                <div
                    className="min-h-0 flex-1 px-2 py-2"
                    onPointerDownCapture={preserveBrowsingPosition}
                    onTouchMoveCapture={preserveBrowsingPosition}
                    onWheelCapture={preserveBrowsingPosition}
                    onKeyDownCapture={(event) => {
                        if (
                            [
                                "ArrowUp",
                                "ArrowDown",
                                "PageUp",
                                "PageDown",
                                "Home",
                                "End",
                                " ",
                            ].includes(event.key)
                        ) {
                            preserveBrowsingPosition();
                        }
                    }}
                >
                    <Virtuoso
                        ref={virtuosoRef}
                        style={{ height: "100%" }}
                        totalCount={queueTracks.length}
                        initialItemCount={Math.min(
                            queueTracks.length,
                            INITIAL_WINDOW_COUNT,
                        )}
                        initialTopMostItemIndex={{
                            index: resolveQueueCenteringIndex(
                                currentIndex,
                                queueTracks.length,
                            ),
                            align: "center",
                        }}
                        defaultItemHeight={ESTIMATED_ROW_HEIGHT}
                        computeItemKey={(index) => {
                            const item = queueTracks[index];
                            return item ? `${item.id}-${index}` : index;
                        }}
                        itemContent={(queueIndex) => {
                            const item = queueTracks[queueIndex];
                            if (!item) return null;
                            const rowProps = {
                                queueIndex,
                                isCurrentTrack: queueIndex === currentIndex,
                                isEarlierInQueue: queueIndex < currentIndex,
                                onPlayFromQueue,
                                onRemoveFromQueue,
                            };
                            return isEpisodeQueueItem(item) ? (
                                <OverlayQueueEpisodeRow
                                    item={item}
                                    {...rowProps}
                                />
                            ) : (
                                <OverlayQueueTrackRow
                                    track={item}
                                    {...rowProps}
                                />
                            );
                        }}
                    />
                </div>
            )}
        </motion.section>
    );
});
