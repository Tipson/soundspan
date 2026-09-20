import { useState, type ReactNode } from "react";
import {
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
import { ShareLinkModal } from "@/components/ui/ShareLinkModal";
import type { Album, AlbumSource } from "../types";
import {
    getAlbumActionVisibility,
    type AlbumActionVisibility,
} from "../albumActionVisibility";
import { MusicDetailActionDock } from "@/components/music-detail";
import { MusicDetailSecondaryActions } from "@/components/music-detail/MusicDetailSecondaryActions";
import { ru } from "@/lib/i18n/ru";

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
    onShuffle: () => void;
}

function PlaybackControls(props: PlaybackControlsProps) {
    return (
        <>
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

function LockedPlaybackControls() {
    return (
        <>
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

function LockedControls(props: { visibility: AlbumActionVisibility }) {
    return (
        <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-2.5 py-1.5">
            {props.visibility.isLibraryVisible && <LockedPlaybackControls />}
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
            <span>
                {props.liked ? ru.catalog.unlikeAlbum : ru.catalog.likeAlbum}
            </span>
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
                    <span>{ru.common.addQueue}</span>
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
                    <span>{ru.catalog.shareAlbum}</span>
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
                    <span>{ru.common.addPlaylist}</span>
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
                    <span>{ru.catalog.deleteAlbum}</span>
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
        <MusicDetailActionDock
            label={ru.catalog.albumControls}
            className="min-h-11 w-fit gap-1 rounded-none border-0 bg-transparent p-0 shadow-none backdrop-blur-none supports-[backdrop-filter]:bg-transparent"
        >
            <div
                data-detail-action-tier="primary"
                className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none"
            >
                {actions.isInListenTogetherGroup &&
                visibility.hasLockedControls ? (
                    <LockedControls visibility={visibility} />
                ) : (
                    visibility.isLibraryVisible && (
                        <PlaybackControls onShuffle={actions.onShuffle} />
                    )
                )}
            </div>
            <MusicDetailSecondaryActions>
                {(close) => (
                    <SecondaryControls
                        visibility={visibility}
                        onAddAllToQueue={() => {
                            close();
                            actions.onAddAllToQueue?.();
                        }}
                        onAddToPlaylist={() => {
                            close();
                            actions.onAddToPlaylist();
                        }}
                        onShare={() => {
                            close();
                            props.onShare();
                        }}
                        onToggleAlbumLike={actions.onToggleAlbumLike}
                        liked={actions.isAlbumLiked ?? false}
                        applying={actions.isApplyingAlbumPreference ?? false}
                        onDeleteAlbum={
                            actions.onDeleteAlbum
                                ? () => {
                                      close();
                                      actions.onDeleteAlbum?.();
                                  }
                                : undefined
                        }
                        librarySaveControl={actions.librarySaveControl}
                        deviceDownloadControl={actions.deviceDownloadControl}
                    />
                )}
            </MusicDetailSecondaryActions>
        </MusicDetailActionDock>
    );
}

/** Renders album actions from the pure visibility policy. */
export function AlbumActionBar(props: AlbumActionBarProps) {
    const [showShareModal, setShowShareModal] = useState(false);
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
    const openShare = () => setShowShareModal(true);

    return (
        <div className="w-full space-y-2">
            <ActionControlRow
                actions={props}
                visibility={visibility}
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
