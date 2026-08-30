import type { ReactNode } from "react";
import {
    Play,
    Pause,
    Shuffle,
    Radio,
    ListMusic,
    Loader2,
    Plus,
    Heart,
} from "lucide-react";
import { cn } from "@/utils/cn";
import type { Artist } from "../types";
import type { Album } from "../types";
import type { ArtistSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { toast } from "sonner";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { MusicDetailActionDock } from "@/components/music-detail";
import { ru } from "@/lib/i18n/ru";

const BRAND_PLAY = "var(--color-brand-hover)";

interface ArtistActionBarProps {
    artist: Artist;
    albums: Album[];
    source: ArtistSource;
    colors: ColorPalette | null;
    onPlayAll: () => void;
    onShuffle: () => void;
    onDownloadAll: () => void;
    onAddAllToQueue?: () => void;
    onAddToPlaylist?: () => void;
    onLikeAll?: () => void;
    isLikingAll?: boolean;
    onStartRadio?: () => void;
    isPendingDownload: boolean;
    isPlaying?: boolean;
    isPlayingThisArtist?: boolean;
    onPause?: () => void;
    downloadsEnabled?: boolean;
    isInListenTogetherGroup?: boolean;
    librarySaveControl?: ReactNode;
    deviceDownloadControl?: ReactNode;
}

/**
 * Renders the ArtistActionBar component.
 */
export function ArtistActionBar({
    source,
    onPlayAll,
    onShuffle,
    onAddAllToQueue,
    onAddToPlaylist,
    onLikeAll,
    isLikingAll = false,
    onStartRadio,
    isPlaying = false,
    isPlayingThisArtist = false,
    onPause,
    isInListenTogetherGroup = false,
    librarySaveControl,
    deviceDownloadControl,
}: ArtistActionBarProps) {
    const showPause = isPlaying && isPlayingThisArtist;
    const showRadio = source === "library" && onStartRadio;
    const lockMessage = ru.catalog.listenTogetherLock;
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();

    const handleLockedAction = () => {
        toast.error(lockMessage);
    };

    const handlePlayPauseClick = () => {
        triggerPlayFeedback();
        if (showPause && onPause) {
            onPause();
        } else {
            onPlayAll();
        }
    };

    return (
        <div className="w-full space-y-2">
            <MusicDetailActionDock label={ru.catalog.artistControls}>
                {isInListenTogetherGroup ? (
                    <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-2.5 py-1.5">
                        <button
                            onClick={handleLockedAction}
                            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-white/15 bg-white/10 px-5 py-2.5 text-sm font-semibold text-content-muted shadow-lg sm:flex-none"
                            title={lockMessage}
                        >
                            {showPause ? (
                                <Pause className="w-5 h-5 fill-current" />
                            ) : (
                                <Play className="w-5 h-5 fill-current ml-0.5" />
                            )}
                            <span>{showPause ? ru.common.pause : ru.common.playAll}</span>
                        </button>

                        <button
                            onClick={handleLockedAction}
                            className="h-11 w-11 rounded-full border border-white/15 bg-white/10 flex items-center justify-center text-content-muted"
                            title={lockMessage}
                            aria-label={ru.catalog.shuffleUnavailable}
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    </div>
                ) : (
                    <>
                        {/* Play Button */}
                        <button
                            onClick={handlePlayPauseClick}
                            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] motion-reduce:transition-none sm:flex-none"
                            style={{ backgroundColor: BRAND_PLAY }}
                        >
                            {showPlaySpinner ? (
                                <Loader2 className="w-5 h-5 animate-spin text-black" />
                            ) : showPause ? (
                                <Pause className="w-5 h-5 fill-current text-black" />
                            ) : (
                                <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                            )}
                            <span>{showPause ? ru.common.pause : ru.common.playAll}</span>
                        </button>

                        {/* Shuffle Button */}
                        <button
                            onClick={onShuffle}
                            className="h-11 w-11 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title={ru.common.shuffle}
                            aria-label={ru.common.shuffle}
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    </>
                )}

                {librarySaveControl}

                {deviceDownloadControl}

                {onAddAllToQueue && (
                    <button
                        onClick={onAddAllToQueue}
                        className="h-11 w-11 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title={ru.common.addQueue}
                        aria-label={ru.common.addQueue}
                    >
                        <ListMusic className="w-5 h-5" />
                    </button>
                )}

                {onAddToPlaylist && (
                    <button
                        onClick={onAddToPlaylist}
                        className="h-11 w-11 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title={ru.common.addPlaylist}
                        aria-label={ru.common.addPlaylist}
                    >
                        <Plus className="w-5 h-5" />
                    </button>
                )}

                {onLikeAll && (
                    <button
                        onClick={onLikeAll}
                        disabled={isLikingAll}
                        className={cn(
                            "h-11 w-11 rounded-full flex items-center justify-center transition-all",
                            isLikingAll
                                ? "cursor-not-allowed text-white/35"
                                : "text-white/60 hover:bg-white/10 hover:text-white",
                        )}
                        title={ru.catalog.likeAll}
                        aria-label={ru.catalog.likeAll}
                    >
                        {isLikingAll ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Heart className="h-4 w-4" />
                        )}
                    </button>
                )}

                {/* Radio Button - Only for library artists */}
                {showRadio && (
                    <button
                        onClick={onStartRadio}
                        className="h-11 w-11 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title={ru.catalog.artistRadio}
                        aria-label={ru.catalog.artistRadio}
                    >
                        <Radio className="w-5 h-5" />
                    </button>
                )}
            </MusicDetailActionDock>

            {isInListenTogetherGroup && (
                <p className="text-xs text-content-muted">{lockMessage}</p>
            )}
        </div>
    );
}
