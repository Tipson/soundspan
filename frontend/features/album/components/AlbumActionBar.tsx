import { useState, type ReactNode } from "react";
import {
    Play,
    Pause,
    Shuffle,
    ListMusic,
    Plus,
    Share2,
    Loader2,
    Heart,
    Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/utils/cn";
import type { ColorPalette } from "@/hooks/useImageColor";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { ShareLinkModal } from "@/components/ui/ShareLinkModal";
import type { Album, AlbumSource } from "../types";
import {
    getAlbumActionVisibility,
    type AlbumActionVisibility,
} from "../albumActionVisibility";
import { MusicDetailActionDock } from "@/components/music-detail";
import { ru } from "@/lib/i18n/ru";

const BRAND_PLAY = "var(--color-brand-hover)";
const LOCK_MESSAGE = ru.catalog.listenTogetherLock;

interface AlbumActionBarProps {
    album: Album;
    source: AlbumSource;
    colors: ColorPalette | null;
    onPlayAll: () => void;
    onAddAllToQueue?: () => void;
    onShuffle: () => void;
    onDownloadAlbum: () => void;
    onAddToPlaylist: () => void;
    onToggleAlbumLike?: () => void;
    isAlbumLiked?: boolean;
    isPendingDownload: boolean;
    isApplyingAlbumPreference?: boolean;
    isPlaying?: boolean;
    isPlayingThisAlbum?: boolean;
    onPause?: () => void;
    downloadsEnabled?: boolean;
    requestsEnabled?: boolean;
    isRequestedAlbum?: boolean;
    isSubmittingRequest?: boolean;
    onRequestAlbum?: () => void;
    isInListenTogetherGroup?: boolean;
    canDeleteFromLibrary?: boolean;
    onDeleteAlbum?: () => void;
    librarySaveControl?: ReactNode;
    deviceDownloadControl?: ReactNode;
}

interface PlaybackControlsProps {
    showPause: boolean;
    showSpinner: boolean;
    onPlayPause: () => void;
    onShuffle: () => void;
}

function PlaybackControls(props: PlaybackControlsProps) {
    return (
        <>
            <button
                type="button"
                onClick={props.onPlayPause}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] motion-reduce:transition-none sm:flex-none"
                style={{ backgroundColor: BRAND_PLAY }}
            >
                {props.showSpinner ? (
                    <Loader2 className="w-5 h-5 animate-spin text-black" />
                ) : props.showPause ? (
                    <Pause className="w-5 h-5 fill-current text-black" />
                ) : (
                    <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                )}
                <span>
                    {props.showPause ? ru.common.pause : ru.common.playAll}
                </span>
            </button>
            <button
                type="button"
                onClick={props.onShuffle}
                className="h-11 w-11 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                title={ru.common.shuffle}
                aria-label={ru.common.shuffle}
            >
                <Shuffle className="w-5 h-5" />
            </button>
        </>
    );
}

function LockedPlaybackControls({ showPause }: { showPause: boolean }) {
    return (
        <>
            <button
                type="button"
                onClick={() => toast.error(LOCK_MESSAGE)}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-white/15 bg-white/10 px-5 py-2.5 text-sm font-semibold text-content-muted shadow-lg sm:flex-none"
                title={LOCK_MESSAGE}
            >
                {showPause ? (
                    <Pause className="w-5 h-5 fill-current" />
                ) : (
                    <Play className="w-5 h-5 fill-current ml-0.5" />
                )}
                <span>{showPause ? ru.common.pause : ru.common.playAll}</span>
            </button>
            <button
                type="button"
                onClick={() => toast.error(LOCK_MESSAGE)}
                className="h-11 w-11 rounded-full border border-white/15 bg-white/10 flex items-center justify-center text-content-muted"
                title={LOCK_MESSAGE}
                aria-label={ru.catalog.shuffleUnavailable}
            >
                <Shuffle className="w-5 h-5" />
            </button>
        </>
    );
}

function LockedControls(props: {
    visibility: AlbumActionVisibility;
    showPause: boolean;
}) {
    return (
        <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-2.5 py-1.5">
            {props.visibility.isLibraryVisible && (
                <LockedPlaybackControls showPause={props.showPause} />
            )}
        </div>
    );
}

function AlbumPreferenceButton(props: {
    liked: boolean;
    applying: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            onClick={props.onToggle}
            disabled={props.applying}
            className={cn(
                "h-11 w-11 rounded-full flex items-center justify-center transition-colors",
                props.applying
                    ? "cursor-not-allowed text-white/35"
                    : props.liked
                      ? "text-brand hover:bg-white/10"
                      : "text-white/60 hover:bg-white/10 hover:text-white",
            )}
            title={props.liked ? ru.catalog.unlikeAlbum : ru.catalog.likeAlbum}
            aria-label={
                props.liked ? ru.catalog.unlikeAlbum : ru.catalog.likeAlbum
            }
        >
            {props.applying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <Heart
                    className={cn("h-4 w-4", props.liked && "fill-current")}
                />
            )}
        </button>
    );
}

interface SecondaryControlsProps {
    visibility: AlbumActionVisibility;
    onAddAllToQueue?: () => void;
    onAddToPlaylist: () => void;
    onShare: () => void;
    onToggleAlbumLike?: () => void;
    onDeleteAlbum?: () => void;
    liked: boolean;
    applying: boolean;
    librarySaveControl?: ReactNode;
    deviceDownloadControl?: ReactNode;
}

function SecondaryControls(props: SecondaryControlsProps) {
    return (
        <>
            {props.librarySaveControl}
            {props.deviceDownloadControl}
            {props.visibility.canShowAddAllToQueue && (
                <button
                    type="button"
                    onClick={props.onAddAllToQueue}
                    className="h-11 w-11 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                    title={ru.common.addQueue}
                    aria-label={ru.common.addQueue}
                >
                    <ListMusic className="w-5 h-5" />
                </button>
            )}
            {props.visibility.canShareAlbum && (
                <button
                    type="button"
                    onClick={props.onShare}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    title={ru.catalog.shareAlbum}
                    aria-label={ru.catalog.shareAlbum}
                >
                    <Share2 className="h-5 w-5" />
                </button>
            )}
            {props.visibility.canShowAddToPlaylist && (
                <button
                    type="button"
                    onClick={props.onAddToPlaylist}
                    className="h-11 w-11 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                    title={ru.common.addPlaylist}
                    aria-label={ru.common.addPlaylist}
                >
                    <Plus className="w-5 h-5" />
                </button>
            )}
            {props.visibility.canShowAlbumPreference &&
                props.onToggleAlbumLike && (
                    <AlbumPreferenceButton
                        liked={props.liked}
                        applying={props.applying}
                        onToggle={props.onToggleAlbumLike}
                    />
                )}
            {props.visibility.canDeleteAlbum && props.onDeleteAlbum && (
                <button
                    type="button"
                    onClick={props.onDeleteAlbum}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                    title={ru.catalog.deleteAlbum}
                    aria-label={ru.catalog.deleteAlbum}
                >
                    <Trash2 className="h-5 w-5" aria-hidden="true" />
                </button>
            )}
        </>
    );
}

function AlbumActionModals(props: {
    album: Album;
    showShareModal: boolean;
    closeShareModal: () => void;
}) {
    return (
        <>
            <ShareLinkModal
                isOpen={props.showShareModal}
                onClose={props.closeShareModal}
                resourceType="album"
                resourceId={props.album.id}
                resourceName={props.album.title}
            />
        </>
    );
}

function ActionControlRow(props: {
    actions: AlbumActionBarProps;
    visibility: AlbumActionVisibility;
    showPause: boolean;
    showSpinner: boolean;
    onPlayPause: () => void;
    onShare: () => void;
}) {
    const { actions, visibility } = props;
    if (
        !visibility.hasActionControls &&
        !actions.librarySaveControl &&
        !actions.deviceDownloadControl
    ) {
        return null;
    }
    return (
        <MusicDetailActionDock label={ru.catalog.albumControls}>
            <div
                data-detail-action-tier="primary"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
            >
                {actions.isInListenTogetherGroup &&
                visibility.hasLockedControls ? (
                    <LockedControls
                        visibility={visibility}
                        showPause={props.showPause}
                    />
                ) : (
                    visibility.isLibraryVisible && (
                        <PlaybackControls
                            showPause={props.showPause}
                            showSpinner={props.showSpinner}
                            onPlayPause={props.onPlayPause}
                            onShuffle={actions.onShuffle}
                        />
                    )
                )}
            </div>
            <div
                data-detail-action-tier="secondary"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
            >
                <SecondaryControls
                    visibility={visibility}
                    onAddAllToQueue={actions.onAddAllToQueue}
                    onAddToPlaylist={actions.onAddToPlaylist}
                    onShare={props.onShare}
                    onToggleAlbumLike={actions.onToggleAlbumLike}
                    liked={actions.isAlbumLiked ?? false}
                    applying={actions.isApplyingAlbumPreference ?? false}
                    onDeleteAlbum={actions.onDeleteAlbum}
                    librarySaveControl={actions.librarySaveControl}
                    deviceDownloadControl={actions.deviceDownloadControl}
                />
            </div>
        </MusicDetailActionDock>
    );
}

/** Renders album actions from the pure visibility policy. */
export function AlbumActionBar(props: AlbumActionBarProps) {
    const [showShareModal, setShowShareModal] = useState(false);
    const showPause = Boolean(props.isPlaying && props.isPlayingThisAlbum);
    const visibility = getAlbumActionVisibility({
        source: props.source,
        owned: props.album.owned,
        albumId: props.album.id,
        rgMbid: props.album.rgMbid,
        mbid: props.album.mbid,
        downloadsEnabled: props.downloadsEnabled ?? true,
        requestsEnabled:
            (props.requestsEnabled ?? false) && Boolean(props.onRequestAlbum),
        hasAddAllToQueue: Boolean(props.onAddAllToQueue),
        hasAlbumPreferenceAction: Boolean(props.onToggleAlbumLike),
        canDeleteFromLibrary: props.canDeleteFromLibrary ?? false,
        isInListenTogetherGroup: props.isInListenTogetherGroup ?? false,
    });
    const { showSpinner, trigger } = usePlayButtonFeedback();
    const playPause = () => {
        trigger();
        if (showPause && props.onPause) props.onPause();
        else props.onPlayAll();
    };
    const openShare = () => setShowShareModal(true);

    return (
        <div className="w-full space-y-2">
            <ActionControlRow
                actions={props}
                visibility={visibility}
                showPause={showPause}
                showSpinner={showSpinner}
                onPlayPause={playPause}
                onShare={openShare}
            />
            {props.isInListenTogetherGroup && visibility.hasLockedControls && (
                <p className="text-xs text-content-muted">{LOCK_MESSAGE}</p>
            )}
            <AlbumActionModals
                album={props.album}
                showShareModal={showShareModal}
                closeShareModal={() => setShowShareModal(false)}
            />
        </div>
    );
}
