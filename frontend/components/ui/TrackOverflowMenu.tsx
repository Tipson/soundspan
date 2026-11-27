"use client";

import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import {
    EllipsisVertical,
    Link as LinkIcon,
    ListEnd,
    ListPlus,
    Map as MapIcon,
    Plus,
    Share2,
    User,
    Disc3,
    AudioWaveform,
    Radio,
    Check,
    Download,
    Loader2,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { useDismissibleLayer } from "@/hooks/useDismissibleLayer";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track } from "@/lib/audio-state-context";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { ShareLinkModal } from "@/components/ui/ShareLinkModal";
import { getArtistHref } from "@/utils/artistRoute";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
    loadTrackRadio,
    UnsupportedTrackRadioError,
} from "@/lib/radio/loadTrackRadio";
import { requestRadioQueue } from "@/lib/radio/radioRequestIntent";
import {
    isRemoteTrack,
    isPlaybackOnlyTrack,
    normalizeActionableAudioTrack,
    toAddToPlaylistRef,
    canAddTrackToPlaylist,
} from "@/lib/trackRef";
import { canShareTrack } from "@/lib/shareLinks";
import { useOptionalDeviceOffline } from "@/features/device-offline/DeviceOfflineProvider";
import { getDeviceDownloadSourceUrl } from "@/features/device-offline/sourceUrl";
import { pluralRu, ru } from "@/lib/i18n/ru";
import { audiusTrackSchema } from "@/lib/audio/audiusPlayback";
import { useAuth } from "@/lib/auth-context";
import { trackAudioTarget } from "@/lib/audio/trackAudioVersions";
import { TrackAudioVersionModal } from "./TrackAudioVersionModal";

interface TrackOverflowMenuProps {
    track: Track;
    /** Feature flags for which menu items to show */
    showPlayNext?: boolean;
    showAddToQueue?: boolean;
    showAddToPlaylist?: boolean;
    showGoToArtist?: boolean;
    showGoToAlbum?: boolean;
    showMatchVibe?: boolean;
    showVibeMap?: boolean;
    showStartRadio?: boolean;
    /** Disable persistent audio replacement for a tentative search match. */
    allowTrackAudioManagement?: boolean;
    onMatchVibe?: () => void | Promise<void>;
    matchVibeLabel?: string;
    matchVibeDisabled?: boolean;
    /** Extra menu items injected before/after the standard items */
    extraItemsBefore?: React.ReactNode;
    extraItemsAfter?: React.ReactNode;
    /** Styling */
    className?: string;
    triggerClassName?: string;
    menuClassName?: string;
}

/**
 * Renders the TrackOverflowMenu component.
 */
export function TrackOverflowMenu({
    track,
    showPlayNext = true,
    showAddToQueue = true,
    showAddToPlaylist = true,
    showGoToArtist = true,
    showGoToAlbum = true,
    showMatchVibe = true,
    showVibeMap = true,
    showStartRadio = true,
    allowTrackAudioManagement = true,
    onMatchVibe,
    matchVibeLabel,
    matchVibeDisabled = false,
    extraItemsBefore,
    extraItemsAfter,
    className,
    triggerClassName,
    menuClassName,
}: TrackOverflowMenuProps) {
    const [isOpen, setIsOpen] = useState(false);
    useDismissibleLayer(isOpen, () => setIsOpen(false), 200);
    const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
    const [isShareModalOpen, setIsShareModalOpen] = useState(false);
    const [isAudioModalOpen, setIsAudioModalOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const popupRef = useRef<HTMLDivElement | null>(null);
    const [popupPosition, setPopupPosition] = useState<{
        left: number;
        top: number;
        maxWidth: number;
        maxHeight: number;
    } | null>(null);
    const router = useRouter();
    const controls = useAudioControls();
    const user = useAuth({ optional: true })?.user;
    const deviceOffline = useOptionalDeviceOffline();
    const normalizedActionTrack = useMemo(
        () => normalizeActionableAudioTrack(track),
        [track],
    );
    const isActionable = normalizedActionTrack !== null;
    const actionTrack = normalizedActionTrack ?? track;
    const canPersist = isActionable && !isPlaybackOnlyTrack(actionTrack);
    const audioTarget =
        allowTrackAudioManagement && user?.role === "admin" && isActionable
            ? trackAudioTarget(actionTrack)
            : null;
    const canAddToPlaylist = isActionable && canAddTrackToPlaylist(actionTrack);
    const canDownload =
        canPersist ||
        (isActionable && Boolean(actionTrack.musicSourceRecording));
    // Restored queue metadata is untrusted; only the provider's public page can leave the app.
    const attribution = isPlaybackOnlyTrack(actionTrack)
        ? audiusTrackSchema.shape.attributionUrl.safeParse(track.sourcePageUrl)
        : null;
    const sourcePageUrl = attribution?.success ? attribution.data : null;
    const isRemote = isRemoteTrack(track);
    const deviceRecord = deviceOffline?.recordForTrack(actionTrack) ?? null;
    const deviceStorageStatus = deviceOffline?.storage.status ?? null;
    const deviceStorageBlocked =
        deviceStorageStatus === "unsupported" ||
        deviceStorageStatus === "checking" ||
        deviceStorageStatus === "requesting";
    const isAutoManagedReady =
        deviceRecord?.status === "ready" &&
        deviceRecord.management === "auto-liked";
    const deviceDownloadDisabled =
        deviceRecord?.status === "downloading" ||
        (deviceRecord?.status === "ready" && !isAutoManagedReady) ||
        deviceStorageBlocked;
    const deviceDownloadLabel = (() => {
        if (deviceRecord?.status === "ready" && !isAutoManagedReady) {
            return ru.trackMenu.availableOffline;
        }
        if (deviceRecord?.status === "downloading")
            return ru.downloads.downloading;
        if (deviceStorageStatus === "unsupported") {
            return ru.trackMenu.unavailable;
        }
        if (deviceStorageStatus === "checking") {
            return ru.trackMenu.checkingStorage;
        }
        if (deviceStorageStatus === "requesting") {
            return ru.trackMenu.waitingFolder;
        }
        if (deviceStorageStatus === "needs-setup") {
            return ru.trackMenu.chooseFolder;
        }
        if (deviceStorageStatus === "error") {
            return deviceOffline?.storage.directoryName
                ? ru.trackMenu.reconnectFolder
                : ru.trackMenu.chooseFolder;
        }
        if (isAutoManagedReady) return ru.trackMenu.keepOffline;
        return deviceRecord
            ? ru.trackMenu.retryDownload
            : ru.trackMenu.download;
    })();

    const effectiveShowMatchVibe =
        showMatchVibe && (!isRemote || Boolean(onMatchVibe));
    const effectiveShowVibeMap = showVibeMap && !isRemote;
    const showShare = canShareTrack(track);

    // Artist href
    const artistHref = track.artist
        ? getArtistHref({
              id: track.artist.id,
              name: track.artist.name,
              mbid: track.artist.mbid,
          })
        : null;

    // Album href
    const albumHref = track.album?.id ? `/album/${track.album.id}` : null;

    // Song deep link — the album page consumes ?track= by scrolling to the
    // row and starting playback. Only local tracks with album identity have
    // a stable URL to hand out.
    const trackLinkPath =
        !isRemote && track.album?.id
            ? `/album/${track.album.id}?track=${encodeURIComponent(track.id)}`
            : null;

    // Escape rounded/virtualized list clipping, but stay anchored and inside
    // the visible viewport. Prefer the side with room; long menus scroll.
    useLayoutEffect(() => {
        if (!isOpen || !triggerRef.current || !popupRef.current) return;
        const anchor = triggerRef.current.getBoundingClientRect();
        const popup = popupRef.current.getBoundingClientRect();
        const viewport = window.visualViewport;
        const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
        const topEdge = (viewport?.offsetTop ?? 0) + 8;
        const rightEdge =
            leftEdge + (viewport?.width ?? window.innerWidth) - 16;
        const bottomEdge =
            topEdge + (viewport?.height ?? window.innerHeight) - 16;
        const maxWidth = Math.max(0, rightEdge - leftEdge);
        const width = Math.min(popup.width, maxWidth);
        const below = Math.max(0, bottomEdge - anchor.bottom - 4);
        const above = Math.max(0, anchor.top - topEdge - 4);
        const openBelow = popup.height <= below || below >= above;
        const maxHeight = openBelow ? below : above;
        const height = Math.min(popup.height, maxHeight);
        setPopupPosition({
            left: Math.max(
                leftEdge,
                Math.min(anchor.right - width, rightEdge - width),
            ),
            top: Math.max(
                topEdge,
                Math.min(
                    openBelow ? anchor.bottom + 4 : anchor.top - height - 4,
                    bottomEdge - height,
                ),
            ),
            maxWidth,
            maxHeight,
        });
    }, [isOpen, menuClassName, track.id]);

    // Outside click and escape handlers
    useEffect(() => {
        if (!isOpen) return;

        const handleOutsideClick = (event: MouseEvent) => {
            if (
                menuRef.current &&
                !menuRef.current.contains(event.target as Node) &&
                !popupRef.current?.contains(event.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsOpen(false);
            }
        };
        const handleScroll = (event: Event) => {
            if (
                !(event.target instanceof Node) ||
                !popupRef.current?.contains(event.target)
            )
                setIsOpen(false);
        };
        const handleResize = () => setIsOpen(false);

        document.addEventListener("mousedown", handleOutsideClick);
        document.addEventListener("keydown", handleEscape);
        window.addEventListener("scroll", handleScroll, true);
        window.addEventListener("resize", handleResize);
        window.visualViewport?.addEventListener("resize", handleResize);
        window.visualViewport?.addEventListener("scroll", handleResize);

        return () => {
            document.removeEventListener("mousedown", handleOutsideClick);
            document.removeEventListener("keydown", handleEscape);
            window.removeEventListener("scroll", handleScroll, true);
            window.removeEventListener("resize", handleResize);
            window.visualViewport?.removeEventListener("resize", handleResize);
            window.visualViewport?.removeEventListener("scroll", handleResize);
        };
    }, [isOpen]);

    const handleToggle = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setPopupPosition(null);
        setIsOpen((prev) => !prev);
    }, []);

    const closeMenu = useCallback(() => setIsOpen(false), []);

    const handlePlayNext = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (!isActionable) return;
            controls.playNext(actionTrack);
            closeMenu();
        },
        [actionTrack, controls, closeMenu, isActionable],
    );

    const handleAddToQueue = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (!isActionable) return;
            controls.addToQueue(actionTrack);
            closeMenu();
        },
        [actionTrack, controls, closeMenu, isActionable],
    );

    const handleAddToPlaylist = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (!canAddToPlaylist) return;
            closeMenu();
            setIsPlaylistSelectorOpen(true);
        },
        [closeMenu, canAddToPlaylist],
    );

    const handleShare = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            closeMenu();
            setIsShareModalOpen(true);
        },
        [closeMenu],
    );

    const handleSelectPlaylist = useCallback(
        async (playlistId: string) => {
            if (!canAddToPlaylist) return;
            await api.addTrackToPlaylist(
                playlistId,
                toAddToPlaylistRef(actionTrack),
            );
            toast.success(`«${track.title}» добавлен в плейлист`);
        },
        [actionTrack, canAddToPlaylist, track.title],
    );

    const handleCopyTrackLink = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            closeMenu();
            if (!trackLinkPath) return;
            const url = `${window.location.origin}${trackLinkPath}`;
            void navigator.clipboard.writeText(url).then(
                () => toast.success(ru.trackMenu.copySuccess),
                () => toast.error(ru.trackMenu.copyFailed),
            );
        },
        [trackLinkPath, closeMenu],
    );

    const handleGoToArtist = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (artistHref) {
                router.push(artistHref);
            }
            closeMenu();
        },
        [artistHref, router, closeMenu],
    );

    const handleGoToAlbum = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (albumHref) {
                router.push(albumHref);
            }
            closeMenu();
        },
        [albumHref, router, closeMenu],
    );

    const handleMatchVibe = useCallback(
        async (e: React.MouseEvent) => {
            e.stopPropagation();
            if (onMatchVibe) {
                closeMenu();
                void onMatchVibe();
                return;
            }
            if (!isActionable) return;
            closeMenu();
            // Play the track first, then start vibe mode
            controls.playTrack(actionTrack);
            // Small delay to let the track load before starting vibe
            setTimeout(async () => {
                const result = await controls.startVibeMode();
                if (result.success) {
                    toast.success(
                        `Найдено ${result.trackCount} ${pluralRu(result.trackCount, ["похожий трек", "похожих трека", "похожих треков"])}`,
                    );
                }
            }, 500);
        },
        [actionTrack, controls, closeMenu, isActionable, onMatchVibe],
    );

    const handleShowVibeMap = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            closeMenu();
            router.push(`/vibe?trackId=${encodeURIComponent(track.id)}`);
        },
        [track.id, router, closeMenu],
    );

    const handleStartRadio = useCallback(
        async (e: React.MouseEvent) => {
            e.stopPropagation();
            closeMenu();
            try {
                const filtered = await requestRadioQueue(() =>
                    loadTrackRadio(actionTrack),
                );
                if (!filtered) return;
                if (filtered.length === 0) {
                    toast.error(ru.trackMenu.radioNotEnough);
                    return;
                }
                controls.playTracks(
                    isActionable ? [actionTrack, ...filtered] : filtered,
                    0,
                    true,
                    {
                        replaceQueue: true,
                        radioOrigin: filtered[0]?.radioOrigin,
                    },
                );
                toast.success(
                    `Радио «${track.title}»: ${filtered.length} ${pluralRu(filtered.length, ["трек", "трека", "треков"])}`,
                );
            } catch (error) {
                if (error instanceof UnsupportedTrackRadioError) {
                    toast.error(error.message);
                    return;
                }
                toast.error(ru.trackMenu.radioFailed);
            }
        },
        [actionTrack, track, controls, closeMenu, isActionable, isRemote],
    );

    const handleDeviceDownload = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            closeMenu();
            if (!canDownload || !deviceOffline || deviceDownloadDisabled)
                return;
            try {
                const sourceUrl = getDeviceDownloadSourceUrl(actionTrack);
                void deviceOffline
                    .download({
                        track: actionTrack,
                        sourceUrl,
                        quality: "auto",
                    })
                    .then((record) =>
                        toast.success(
                            record.status === "ready"
                                ? `«${track.title}» доступен без интернета`
                                : `Загрузка «${track.title}» началась`,
                        ),
                    )
                    .catch((error: unknown) =>
                        toast.error(
                            error instanceof Error
                                ? error.message
                                : ru.trackMenu.downloadFailed,
                        ),
                    );
            } catch (error) {
                toast.error(
                    error instanceof Error
                        ? error.message
                        : ru.trackMenu.downloadFailed,
                );
            }
        },
        [
            actionTrack,
            closeMenu,
            deviceDownloadDisabled,
            deviceOffline,
            canDownload,
            track.title,
        ],
    );

    return (
        <>
            <div
                ref={menuRef}
                className={cn(
                    "relative flex items-center justify-center",
                    className,
                )}
            >
                <button
                    ref={triggerRef}
                    type="button"
                    onClick={handleToggle}
                    className={cn(
                        "flex size-11 items-center justify-center rounded-xl p-0 opacity-100 transition-colors focus-visible:ring-2 focus-visible:ring-brand sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100",
                        isOpen
                            ? "bg-surface-active text-content"
                            : "text-content-muted hover:bg-surface-hover hover:text-content",
                        triggerClassName,
                    )}
                    aria-label={ru.trackMenu.actions}
                    aria-expanded={isOpen}
                    aria-haspopup="menu"
                    title={ru.trackMenu.actions}
                >
                    <EllipsisVertical className="h-4 w-4" />
                </button>

                {isOpen &&
                    typeof document !== "undefined" &&
                    createPortal(
                        <div
                            ref={popupRef}
                            className={cn(
                                "fixed z-[10001] overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface-overlay p-1.5 shadow-2xl",
                                menuClassName,
                            )}
                            style={{
                                position: "fixed",
                                left: popupPosition?.left ?? 0,
                                top: popupPosition?.top ?? 0,
                                right: "auto",
                                bottom: "auto",
                                margin: 0,
                                width: "max-content",
                                minWidth: popupPosition
                                    ? Math.min(220, popupPosition.maxWidth)
                                    : "min(220px, calc(100vw - 16px))",
                                maxWidth:
                                    popupPosition?.maxWidth ??
                                    "calc(100vw - 16px)",
                                maxHeight:
                                    popupPosition?.maxHeight ??
                                    "calc(100dvh - 16px)",
                                visibility: popupPosition
                                    ? "visible"
                                    : "hidden",
                            }}
                            role="menu"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                        >
                            {extraItemsBefore}

                            {sourcePageUrl && (
                                <a
                                    href={sourcePageUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    role="menuitem"
                                    onClick={closeMenu}
                                    className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-content-body transition-colors hover:bg-surface-hover hover:text-content focus-visible:ring-2 focus-visible:ring-brand"
                                    aria-label="Открыть страницу трека в Audius (новая вкладка)"
                                >
                                    <LinkIcon
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                    Открыть в Audius
                                </a>
                            )}

                            {showPlayNext && isActionable && (
                                <MenuButton
                                    onClick={handlePlayNext}
                                    icon={<ListEnd className="h-4 w-4" />}
                                    label={ru.trackMenu.playNext}
                                />
                            )}

                            {showAddToQueue && isActionable && (
                                <MenuButton
                                    onClick={handleAddToQueue}
                                    icon={<ListPlus className="h-4 w-4" />}
                                    label={ru.trackMenu.addQueue}
                                />
                            )}

                            {showAddToPlaylist && canAddToPlaylist && (
                                <MenuButton
                                    onClick={handleAddToPlaylist}
                                    icon={<Plus className="h-4 w-4" />}
                                    label={ru.trackMenu.addPlaylist}
                                />
                            )}

                            {deviceOffline && canDownload && (
                                <MenuButton
                                    onClick={handleDeviceDownload}
                                    disabled={deviceDownloadDisabled}
                                    icon={
                                        deviceRecord?.status === "ready" &&
                                        !isAutoManagedReady ? (
                                            <Check className="h-4 w-4" />
                                        ) : deviceRecord?.status ===
                                          "downloading" ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Download className="h-4 w-4" />
                                        )
                                    }
                                    label={deviceDownloadLabel}
                                />
                            )}

                            {showShare && (
                                <MenuButton
                                    onClick={handleShare}
                                    icon={<Share2 className="h-4 w-4" />}
                                    label={ru.common.share}
                                />
                            )}

                            {trackLinkPath && (
                                <MenuButton
                                    onClick={handleCopyTrackLink}
                                    icon={<LinkIcon className="h-4 w-4" />}
                                    label={ru.trackMenu.copyLink}
                                />
                            )}

                            {showGoToArtist && artistHref && (
                                <MenuButton
                                    onClick={handleGoToArtist}
                                    icon={<User className="h-4 w-4" />}
                                    label={ru.trackMenu.goArtist}
                                />
                            )}

                            {showGoToAlbum && albumHref && (
                                <MenuButton
                                    onClick={handleGoToAlbum}
                                    icon={<Disc3 className="h-4 w-4" />}
                                    label={ru.trackMenu.goAlbum}
                                />
                            )}

                            {effectiveShowMatchVibe && track.id && (
                                <MenuButton
                                    onClick={handleMatchVibe}
                                    disabled={matchVibeDisabled}
                                    icon={<AudioWaveform className="h-4 w-4" />}
                                    label={
                                        matchVibeLabel ?? ru.trackMenu.matchVibe
                                    }
                                />
                            )}

                            {effectiveShowVibeMap && track.id && (
                                <MenuButton
                                    onClick={handleShowVibeMap}
                                    icon={<MapIcon className="h-4 w-4" />}
                                    label={ru.trackMenu.showVibeMap}
                                />
                            )}

                            {showStartRadio &&
                                ((isRemote && track.artist?.name) ||
                                    (!isRemote && track.artist?.id)) && (
                                    <MenuButton
                                        onClick={handleStartRadio}
                                        icon={<Radio className="h-4 w-4" />}
                                        label={ru.trackMenu.startRadio}
                                    />
                                )}

                            {audioTarget && (
                                <MenuButton
                                    onClick={() => {
                                        triggerRef.current?.focus();
                                        setIsOpen(false);
                                        setIsAudioModalOpen(true);
                                    }}
                                    icon={<AudioWaveform className="h-4 w-4" />}
                                    label="Полная версия трека"
                                />
                            )}
                            {extraItemsAfter}
                        </div>,
                        document.body,
                    )}
            </div>

            <PlaylistSelector
                isOpen={canAddToPlaylist && isPlaylistSelectorOpen}
                onClose={() => setIsPlaylistSelectorOpen(false)}
                onSelectPlaylist={handleSelectPlaylist}
            />
            <ShareLinkModal
                isOpen={isShareModalOpen}
                onClose={() => setIsShareModalOpen(false)}
                resourceType="track"
                resourceId={track.id}
                resourceName={track.title}
            />
            {isAudioModalOpen && audioTarget && (
                <TrackAudioVersionModal
                    key={`${audioTarget.source}:${audioTarget.trackId}`}
                    target={audioTarget}
                    trackName={actionTrack.title}
                    onClose={() => setIsAudioModalOpen(false)}
                />
            )}
        </>
    );
}

/** Shared menu item button */
function MenuButton({
    onClick,
    disabled = false,
    icon,
    label,
    disabledTitle,
    className: customClassName,
}: {
    onClick: (e: React.MouseEvent) => void;
    disabled?: boolean;
    icon: React.ReactNode;
    label: string;
    disabledTitle?: string;
    className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                disabled
                    ? "cursor-not-allowed text-error/75"
                    : "text-content-body hover:bg-surface-hover hover:text-content",
                customClassName,
            )}
            role="menuitem"
            title={disabled && disabledTitle ? disabledTitle : label}
        >
            {icon}
            {label}
        </button>
    );
}

/** Re-export MenuButton for use in extraItemsBefore/After slots */
export { MenuButton as TrackMenuButton };
