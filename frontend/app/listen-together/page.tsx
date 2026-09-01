"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import {
    Radio,
    Users,
    Copy,
    LogOut,
    Crown,
    Trash2,
    Globe,
    Lock,
    Wifi,
    WifiOff,
    Music,
    AlertTriangle,
    RefreshCw,
    Disc3,
} from "lucide-react";
import {
    TrackOverflowMenu,
    TrackMenuButton,
} from "@/components/ui/TrackOverflowMenu";
import { useAuth } from "@/lib/auth-context";
import { useListenTogether } from "@/lib/listen-together-context";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { EqBars } from "@/components/ui/EqBars";
import { PageHeader } from "@/components/layout/PageHeader";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { useVisibilityGatedInterval } from "@/hooks/useVisibilityGatedInterval";
import type { SyncQueueItem } from "@/lib/listen-together-socket";
import {
    formatListenerCount,
    formatReconnectStatus,
    listenTogetherRu,
} from "@/lib/i18n/listenDeviceRu";
import { userFacingError } from "@/lib/i18n/ru";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscoverableGroup {
    id: string;
    name: string;
    joinCode: string;
    groupType: "host-follower";
    visibility: "public" | "private";
    host: { id: string; username: string };
    memberCount: number;
    isMember: boolean;
    isPlaying: boolean;
    currentTrack: { id: string; title: string; artistName: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ViewState = "lobby" | "active";

function CoverThumb({
    coverArt,
    title,
    size = 36,
    className,
}: {
    coverArt: string | null;
    title: string;
    size?: number;
    className?: string;
}) {
    const [hasError, setHasError] = useState(false);
    // Request ~2x the rendered CSS size so the backend serves a small variant
    const imgSrc = coverArt ? api.getCoverArtUrl(coverArt, size * 2) : null;

    if (!imgSrc || hasError) {
        return (
            <div
                className={cn(
                    "flex items-center justify-center bg-surface-hover rounded flex-shrink-0",
                    className,
                )}
                style={{ width: size, height: size }}
            >
                <Disc3
                    className="text-content-disabled"
                    style={{ width: size * 0.45, height: size * 0.45 }}
                />
            </div>
        );
    }

    return (
        <div
            className={cn(
                "relative overflow-hidden bg-surface-hover rounded flex-shrink-0",
                className,
            )}
            style={{ width: size, height: size }}
        >
            <Image
                src={imgSrc}
                alt={title}
                fill
                sizes={`${size}px`}
                className="object-cover"
                unoptimized
                onError={() => setHasError(true)}
            />
        </div>
    );
}

const fadeSlide = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 },
    transition: { duration: 0.2, ease: "easeOut" as const },
};

// ---------------------------------------------------------------------------
// Lobby -- Create / Join / Discover
// ---------------------------------------------------------------------------

function LobbyView() {
    const {
        createGroup,
        joinGroup,
        error,
        clearError,
        socketRouteStatus,
        socketRouteError,
        canUseListenTogether,
        recheckSocketRoute,
    } = useListenTogether();

    const [joinCode, setJoinCode] = useState("");
    const [groupName, setGroupName] = useState("");
    const [isPublic, setIsPublic] = useState(true);
    const [useCurrentQueue, setUseCurrentQueue] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [isJoining, setIsJoining] = useState(false);
    const [discoverGroups, setDiscoverGroups] = useState<DiscoverableGroup[]>(
        [],
    );
    const [isLoadingDiscover, setIsLoadingDiscover] = useState(false);
    const routeChecking = socketRouteStatus === "checking";
    const routeBlocked = socketRouteStatus === "failed";

    // Fetch discoverable groups
    const fetchDiscover = useCallback(async (silent: boolean = false) => {
        if (!silent) setIsLoadingDiscover(true);
        try {
            const groups = await api.discoverListenGroups();
            setDiscoverGroups(Array.isArray(groups) ? groups : []);
        } catch {
            // Silently fail -- discovery is optional
        } finally {
            if (!silent) setIsLoadingDiscover(false);
        }
    }, []);

    useEffect(() => {
        fetchDiscover();
    }, [fetchDiscover]);

    useVisibilityGatedInterval(() => void fetchDiscover(true), 5000);

    const handleCreate = async () => {
        if (!canUseListenTogether) {
            toast.error(
                userFacingError(
                    socketRouteError,
                    listenTogetherRu.routeUnavailableToast,
                ),
            );
            return;
        }
        setIsCreating(true);
        clearError();
        await createGroup({
            name: groupName.trim() || undefined,
            visibility: isPublic ? "public" : "private",
            useCurrentQueue,
        });
        setIsCreating(false);
    };

    const handleJoin = async () => {
        if (!canUseListenTogether) {
            toast.error(
                userFacingError(
                    socketRouteError,
                    listenTogetherRu.routeUnavailableToast,
                ),
            );
            return;
        }
        if (!joinCode.trim()) return;
        setIsJoining(true);
        clearError();
        await joinGroup(joinCode.trim());
        setIsJoining(false);
    };

    const handleJoinById = async (groupId: string) => {
        if (!canUseListenTogether) {
            toast.error(
                userFacingError(
                    socketRouteError,
                    listenTogetherRu.routeUnavailableToast,
                ),
            );
            return;
        }
        setIsJoining(true);
        clearError();
        try {
            const group = discoverGroups.find((g) => g.id === groupId);
            if (!group) return;
            await joinGroup(group.joinCode);
        } finally {
            setIsJoining(false);
        }
    };

    return (
        <motion.div
            className="space-y-8 motion-reduce:transform-none motion-reduce:transition-none"
            {...fadeSlide}
        >
            {/* Route warnings */}
            {routeBlocked && (
                <div
                    role="alert"
                    className="flex items-start gap-3 rounded-2xl border border-error/25 bg-error/5 px-4 py-4"
                >
                    <AlertTriangle className="mt-0.5 size-5 flex-shrink-0 text-error" />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-content">
                            {listenTogetherRu.routeUnavailableTitle}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-content-muted">
                            {userFacingError(
                                socketRouteError,
                                listenTogetherRu.routeErrorFallback,
                            )}
                        </p>
                        <p className="mt-1.5 break-words text-xs leading-5 text-content-muted">
                            {listenTogetherRu.routeSetupPrefix}{" "}
                            <code className="font-mono">
                                /socket.io/listen-together
                            </code>{" "}
                            {listenTogetherRu.routeSetupMiddle}{" "}
                            <code className="font-mono">
                                docs/REVERSE_PROXY_AND_TUNNELS.md
                            </code>
                            .
                        </p>
                        <Button
                            variant="ghost"
                            className="mt-3 border border-error/25 text-xs text-error hover:bg-error/10"
                            onClick={() => {
                                void recheckSocketRoute();
                            }}
                        >
                            <RefreshCw className="mr-1.5 h-3 w-3" />
                            {listenTogetherRu.retryRoute}
                        </Button>
                    </div>
                </div>
            )}

            {routeChecking && !routeBlocked && (
                <div
                    role="status"
                    className="flex min-h-11 items-center gap-2 px-1 text-sm text-content-secondary"
                >
                    <Wifi className="h-3.5 w-3.5 animate-pulse text-brand motion-reduce:animate-none" />
                    {listenTogetherRu.checkingRoute}
                </div>
            )}

            {/* Main grid */}
            <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                {/* Left column: Create + Join */}
                <div className="space-y-5">
                    {/* Create a Group */}
                    <section className="rounded-2xl border border-line bg-surface-elevated p-5">
                        <h2 className="mb-1 text-lg font-semibold text-content">
                            {listenTogetherRu.createTitle}
                        </h2>
                        <p className="mb-5 text-sm leading-6 text-content-muted">
                            {listenTogetherRu.createDescription}
                        </p>

                        <div className="space-y-3">
                            <label
                                htmlFor="listen-group-name"
                                className="block text-sm font-medium text-content"
                            >
                                {listenTogetherRu.groupNamePlaceholder}
                            </label>
                            <Input
                                id="listen-group-name"
                                placeholder={
                                    listenTogetherRu.groupNamePlaceholder
                                }
                                value={groupName}
                                onChange={(e) => setGroupName(e.target.value)}
                                className="min-h-11"
                            />

                            <div className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2">
                                <div className="flex items-center gap-2">
                                    {isPublic ? (
                                        <Globe className="w-4 h-4 text-brand" />
                                    ) : (
                                        <Lock className="w-4 h-4 text-content-disabled" />
                                    )}
                                    <span className="text-sm text-content-body">
                                        {isPublic
                                            ? listenTogetherRu.publicGroup
                                            : listenTogetherRu.privateGroup}
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setIsPublic((prev) => !prev)}
                                    role="switch"
                                    aria-checked={isPublic}
                                    aria-label={
                                        listenTogetherRu.visibilitySwitch
                                    }
                                    className="flex size-11 shrink-0 items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover"
                                >
                                    <span
                                        className={cn(
                                            "relative h-6 w-11 rounded-full transition-colors",
                                            isPublic
                                                ? "bg-brand"
                                                : "bg-surface-active",
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "absolute top-0.5 size-5 rounded-full bg-content transition-[left]",
                                                isPublic
                                                    ? "left-[22px]"
                                                    : "left-0.5",
                                            )}
                                        />
                                    </span>
                                </button>
                            </div>

                            <div className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2">
                                <div className="flex items-center gap-2">
                                    <Music className="w-4 h-4 text-brand" />
                                    <span className="text-sm text-content-body">
                                        {listenTogetherRu.useCurrentQueue}
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setUseCurrentQueue((prev) => !prev)
                                    }
                                    role="switch"
                                    aria-checked={useCurrentQueue}
                                    aria-label={
                                        listenTogetherRu.currentQueueSwitch
                                    }
                                    className="flex size-11 shrink-0 items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover"
                                >
                                    <span
                                        className={cn(
                                            "relative h-6 w-11 rounded-full transition-colors",
                                            useCurrentQueue
                                                ? "bg-brand"
                                                : "bg-surface-active",
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "absolute top-0.5 size-5 rounded-full bg-content transition-[left]",
                                                useCurrentQueue
                                                    ? "left-[22px]"
                                                    : "left-0.5",
                                            )}
                                        />
                                    </span>
                                </button>
                            </div>

                            <Button
                                variant="primary"
                                className="w-full"
                                onClick={handleCreate}
                                disabled={
                                    isCreating ||
                                    !canUseListenTogether ||
                                    routeChecking
                                }
                            >
                                {isCreating ? (
                                    <GradientSpinner
                                        size="sm"
                                        className="mr-2"
                                    />
                                ) : (
                                    <Radio className="w-4 h-4 mr-2" />
                                )}
                                {listenTogetherRu.createTitle}
                            </Button>
                        </div>
                    </section>

                    {/* Join a Group */}
                    <section className="rounded-2xl border border-line bg-surface-elevated p-5">
                        <h2 className="mb-1 text-lg font-semibold text-content">
                            {listenTogetherRu.joinTitle}
                        </h2>
                        <p className="mb-5 text-sm leading-6 text-content-muted">
                            {listenTogetherRu.joinDescription}
                        </p>

                        <label
                            htmlFor="listen-join-code"
                            className="mb-2 block text-sm font-medium text-content"
                        >
                            {listenTogetherRu.joinCodePlaceholder}
                        </label>
                        <div className="flex flex-col gap-3 sm:flex-row">
                            <Input
                                id="listen-join-code"
                                placeholder={
                                    listenTogetherRu.joinCodePlaceholder
                                }
                                value={joinCode}
                                onChange={(e) =>
                                    setJoinCode(e.target.value.toUpperCase())
                                }
                                onKeyDown={(e) =>
                                    e.key === "Enter" && handleJoin()
                                }
                                className="min-h-11 text-center font-mono uppercase tracking-wider"
                            />
                            <Button
                                variant="primary"
                                className="w-full sm:min-w-[120px] sm:w-auto"
                                onClick={handleJoin}
                                disabled={
                                    isJoining ||
                                    !joinCode.trim() ||
                                    !canUseListenTogether ||
                                    routeChecking
                                }
                            >
                                {isJoining && (
                                    <GradientSpinner
                                        size="sm"
                                        className="mr-2"
                                    />
                                )}
                                {listenTogetherRu.join}
                            </Button>
                        </div>

                        {error && (
                            <p role="alert" className="mt-3 text-sm text-error">
                                {userFacingError(
                                    error,
                                    listenTogetherRu.actionFailed,
                                )}
                            </p>
                        )}
                    </section>
                </div>

                {/* Right column: Public Groups */}
                <section className="rounded-2xl border border-line bg-surface-elevated p-5">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <div>
                            <h2 className="mb-0.5 text-lg font-semibold text-content">
                                {listenTogetherRu.publicGroups}
                            </h2>
                            <p className="text-sm leading-6 text-content-muted">
                                {listenTogetherRu.publicGroupsDescription}
                            </p>
                        </div>
                        <Button
                            variant="icon"
                            onClick={() => {
                                void fetchDiscover(false);
                            }}
                            disabled={isLoadingDiscover}
                            aria-label={listenTogetherRu.refreshPublicGroups}
                            title={listenTogetherRu.refreshPublicGroups}
                        >
                            {isLoadingDiscover ? (
                                <GradientSpinner size="sm" />
                            ) : (
                                <RefreshCw className="size-4" />
                            )}
                        </Button>
                    </div>

                    {isLoadingDiscover ? (
                        <div
                            role="status"
                            className="flex justify-center py-12"
                        >
                            <GradientSpinner size="md" />
                        </div>
                    ) : discoverGroups.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-14 text-center">
                            <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-brand/10">
                                <Users className="size-6 text-brand" />
                            </div>
                            <p className="text-sm text-content-disabled">
                                {listenTogetherRu.noPublicGroups}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-1 max-h-[55vh] overflow-y-auto pr-1">
                            {discoverGroups.map((group) => (
                                <button
                                    key={group.id}
                                    onClick={() => handleJoinById(group.id)}
                                    disabled={
                                        isJoining ||
                                        !canUseListenTogether ||
                                        routeChecking
                                    }
                                    className="group flex min-h-14 w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="w-8 h-8 rounded-full bg-brand/10 flex items-center justify-center flex-shrink-0">
                                            <Users className="w-3.5 h-3.5 text-brand" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold text-content">
                                                {group.name}
                                            </p>
                                            <p className="text-xs text-content-disabled">
                                                {formatListenerCount(
                                                    group.memberCount,
                                                )}
                                                {group.currentTrack && (
                                                    <span className="text-content-muted">
                                                        {" "}
                                                        &middot;{" "}
                                                        {
                                                            group.currentTrack
                                                                .title
                                                        }
                                                    </span>
                                                )}
                                            </p>
                                        </div>
                                    </div>
                                    <span className="flex-shrink-0 text-xs font-medium text-brand sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100">
                                        {listenTogetherRu.join}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </motion.div>
    );
}

// ---------------------------------------------------------------------------
// Active Group View -- Queue, Members, Controls
// ---------------------------------------------------------------------------

function ActiveGroupView() {
    const {
        activeGroup,
        isHost,
        canEditQueue,
        canControl,
        isConnected,
        hasConnectedOnce,
        reconnectAttempt,
        socketRouteStatus,
        socketRouteError,
        recheckSocketRoute,
        leaveGroup,
        syncSetTrack,
        syncRemoveFromQueue,
        syncClearQueue,
    } = useListenTogether();

    if (!activeGroup) return null;
    const routeBlocked = socketRouteStatus === "failed";

    const { name, joinCode } = activeGroup;
    const members = activeGroup.members ?? [];
    const playback = activeGroup.playback ?? {
        queue: [],
        currentIndex: 0,
        isPlaying: false,
        positionMs: 0,
        serverTime: 0,
        stateVersion: 0,
        trackId: null,
    };
    const currentTrack = playback.queue?.[playback.currentIndex] ?? null;

    const copyCode = () => {
        navigator.clipboard
            .writeText(joinCode)
            .then(() => {
                toast.success(listenTogetherRu.joinCodeCopied);
            })
            .catch(() => {
                toast.error(listenTogetherRu.copyFailed);
            });
    };

    return (
        <motion.div
            className="space-y-6 motion-reduce:transform-none motion-reduce:transition-none"
            {...fadeSlide}
        >
            {/* Route error */}
            {routeBlocked && (
                <div
                    role="alert"
                    className="flex items-start gap-3 rounded-2xl border border-error/25 bg-error/5 px-4 py-4"
                >
                    <AlertTriangle className="mt-0.5 size-5 flex-shrink-0 text-error" />
                    <div>
                        <p className="text-sm font-semibold text-content">
                            {listenTogetherRu.routeLost}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-content-muted">
                            {userFacingError(
                                socketRouteError,
                                listenTogetherRu.routeErrorFallback,
                            )}
                        </p>
                        <Button
                            variant="ghost"
                            className="mt-3 border border-error/25 text-xs text-error hover:bg-error/10"
                            onClick={() => {
                                void recheckSocketRoute();
                            }}
                        >
                            <RefreshCw className="mr-1.5 h-3 w-3" />
                            {listenTogetherRu.retryRoute}
                        </Button>
                    </div>
                </div>
            )}

            {/* Group header */}
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="flex items-start gap-3 min-w-0">
                    {/* Now playing cover art or fallback icon */}
                    {currentTrack?.album?.coverArt ? (
                        <CoverThumb
                            coverArt={currentTrack.album.coverArt}
                            title={currentTrack.title}
                            size={48}
                            className="rounded-lg"
                        />
                    ) : (
                        <div className="w-12 h-12 rounded-lg bg-brand/10 flex items-center justify-center flex-shrink-0">
                            <Radio className="w-5 h-5 text-brand" />
                        </div>
                    )}
                    <div className="min-w-0">
                        <h2 className="truncate text-lg font-semibold text-content">
                            {name}
                        </h2>
                        <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="ai">
                                {isHost
                                    ? listenTogetherRu.host
                                    : listenTogetherRu.follower}
                            </Badge>
                            <span className="flex items-center gap-1 text-xs text-content-disabled">
                                {routeBlocked ? (
                                    <>
                                        <WifiOff className="size-3 text-error" />{" "}
                                        {listenTogetherRu.routeNeeded}
                                    </>
                                ) : isConnected ? (
                                    <>
                                        <Wifi className="size-3 text-success" />{" "}
                                        {listenTogetherRu.connected}
                                    </>
                                ) : hasConnectedOnce ? (
                                    <>
                                        <WifiOff className="size-3 text-error" />{" "}
                                        {formatReconnectStatus(
                                            reconnectAttempt,
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <Wifi className="size-3 animate-pulse text-brand motion-reduce:animate-none" />{" "}
                                        {listenTogetherRu.connecting}
                                    </>
                                )}
                            </span>
                        </div>
                        {currentTrack ? (
                            <p className="mt-1.5 text-sm text-content-secondary truncate">
                                {currentTrack.title}{" "}
                                <span className="text-content-disabled">
                                    &middot; {currentTrack.artist.name}
                                </span>
                            </p>
                        ) : (
                            <p className="mt-1.5 text-sm text-content-disabled">
                                {listenTogetherRu.nothingPlaying}
                            </p>
                        )}
                    </div>
                </div>

                <button
                    onClick={copyCode}
                    className="flex min-h-11 items-center justify-center gap-2 self-start rounded-xl border border-line bg-surface-elevated px-4 py-2 transition-colors hover:border-brand/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover md:self-center"
                    title={listenTogetherRu.copyJoinCode}
                    aria-label={listenTogetherRu.copyJoinCode}
                >
                    <span className="font-mono text-sm font-bold text-brand tracking-widest">
                        {joinCode}
                    </span>
                    <Copy className="w-3.5 h-3.5 text-content-disabled" />
                </button>
            </div>

            {/* Queue + Members grid */}
            <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                {/* Queue */}
                <section className="rounded-2xl border border-line bg-surface-elevated p-4 sm:p-5">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-xs font-medium text-content-muted uppercase tracking-wider">
                            {listenTogetherRu.queue} ({playback.queue.length})
                        </h3>
                        {canEditQueue && playback.queue.length > 0 && (
                            <button
                                className="flex min-h-11 items-center gap-1 rounded-xl px-3 text-xs font-medium text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover"
                                onClick={syncClearQueue}
                            >
                                <Trash2 className="w-3 h-3" />
                                {listenTogetherRu.clearQueue}
                            </button>
                        )}
                    </div>

                    {playback.queue.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                            <div className="mb-3 flex size-14 items-center justify-center rounded-2xl bg-brand/10">
                                <Music className="size-6 text-brand" />
                            </div>
                            <p className="text-sm text-content-disabled">
                                {listenTogetherRu.emptyQueue}
                            </p>
                            <p className="mt-1 text-xs text-content-muted">
                                {listenTogetherRu.emptyQueueHint}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-0.5 max-h-[58vh] overflow-y-auto pr-1">
                            {playback.queue.map(
                                (item: SyncQueueItem, idx: number) => (
                                    <QueueItem
                                        key={`${item.id}-${idx}`}
                                        item={item}
                                        index={idx}
                                        isCurrentTrack={
                                            idx === playback.currentIndex
                                        }
                                        canStartPlayback={canControl}
                                        canRemove={canEditQueue}
                                        onPlay={() => syncSetTrack(idx)}
                                        onRemove={() =>
                                            syncRemoveFromQueue(idx)
                                        }
                                    />
                                ),
                            )}
                        </div>
                    )}
                </section>

                {/* Members + Leave */}
                <div className="space-y-5">
                    <section className="rounded-2xl border border-line bg-surface-elevated p-4 sm:p-5">
                        <h3 className="text-xs font-medium text-content-muted uppercase tracking-wider mb-3">
                            {listenTogetherRu.listeners} ({members.length})
                        </h3>
                        <div className="space-y-1">
                            {members.map((member) => (
                                <div
                                    key={member.userId}
                                    className="flex min-h-11 items-center justify-between rounded-xl px-3 py-2 transition-colors hover:bg-surface-hover"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="w-7 h-7 rounded-full bg-brand/10 flex items-center justify-center">
                                            <span className="text-[10px] font-bold text-brand">
                                                {member.username?.[0]?.toUpperCase() ??
                                                    "?"}
                                            </span>
                                        </div>
                                        <span className="text-sm font-medium text-content">
                                            {member.username}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {member.isHost && (
                                            <Badge variant="ai">
                                                <Crown className="w-3 h-3 mr-1" />
                                                {listenTogetherRu.host}
                                            </Badge>
                                        )}
                                        <span
                                            className={cn(
                                                "w-2 h-2 rounded-full",
                                                member.isConnected
                                                    ? "bg-success"
                                                    : "bg-content-disabled",
                                            )}
                                            title={
                                                member.isConnected
                                                    ? listenTogetherRu.connected
                                                    : listenTogetherRu.disconnected
                                            }
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <Button
                        variant="danger"
                        className="w-full"
                        onClick={leaveGroup}
                    >
                        <LogOut className="w-4 h-4 mr-2" />
                        {listenTogetherRu.leaveGroup}
                    </Button>
                </div>
            </div>
        </motion.div>
    );
}

// ---------------------------------------------------------------------------
// Queue Item
// ---------------------------------------------------------------------------

function QueueItem({
    item,
    index,
    isCurrentTrack,
    canStartPlayback,
    canRemove,
    onPlay,
    onRemove,
}: {
    item: SyncQueueItem;
    index: number;
    isCurrentTrack: boolean;
    canStartPlayback: boolean;
    canRemove: boolean;
    onPlay: () => void;
    onRemove: () => void;
}) {
    return (
        <div
            className={cn(
                "group flex min-h-14 items-center gap-2 rounded-xl px-2 py-2 transition-colors sm:gap-3 sm:px-3",
                isCurrentTrack
                    ? "bg-brand/8 border-l-2 border-brand"
                    : "hover:bg-surface-overlay",
            )}
        >
            {/* Track Number / EQ / Play */}
            <div className="flex size-11 flex-shrink-0 items-center justify-center">
                {isCurrentTrack ? (
                    <EqBars />
                ) : canStartPlayback ? (
                    <button
                        onClick={onPlay}
                        className="flex size-11 items-center justify-center rounded-full text-content-disabled transition-colors hover:bg-surface-active group-hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover"
                        aria-label={`Воспроизвести «${item.title}»`}
                    >
                        <span className="text-xs">{index + 1}</span>
                    </button>
                ) : (
                    <span className="text-xs text-content-disabled">
                        {index + 1}
                    </span>
                )}
            </div>

            {/* Cover Art */}
            <CoverThumb
                coverArt={item.album.coverArt}
                title={item.title}
                size={36}
                className="rounded"
            />

            {/* Track Info */}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <p
                        className={cn(
                            "text-sm truncate",
                            isCurrentTrack
                                ? "text-brand font-medium"
                                : "text-content",
                        )}
                    >
                        {item.title}
                    </p>
                    {item.streamSource === "tidal" && <TidalBadge />}
                    {item.streamSource === "youtube" && <YouTubeBadge />}
                </div>
                <p className="text-xs text-content-disabled truncate">
                    {item.artist.name} &middot; {item.album.title}
                </p>
            </div>

            {/* Duration */}
            <span className="hidden flex-shrink-0 text-xs tabular-nums text-content-disabled sm:inline">
                {formatTime(item.duration)}
            </span>

            {/* Overflow Menu */}
            <TrackOverflowMenu
                track={{
                    id: item.id,
                    title: item.title,
                    artist: item.artist,
                    album: item.album,
                    duration: item.duration,
                }}
                showPlayNext={false}
                showAddToQueue={false}
                extraItemsAfter={
                    canRemove ? (
                        <TrackMenuButton
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove();
                            }}
                            icon={<Trash2 className="h-4 w-4" />}
                            label={listenTogetherRu.removeFromQueue}
                            className="text-error hover:bg-error/10 hover:text-error"
                        />
                    ) : undefined
                }
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Renders the ListenTogetherPage component.
 */
export default function ListenTogetherPage() {
    const router = useRouter();
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const { isInGroup, isLoading } = useListenTogether();

    // Auth guard
    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [authLoading, isAuthenticated, router]);

    // Derive view from group membership
    const view: ViewState = isInGroup ? "active" : "lobby";

    if (authLoading) {
        return <LoadingScreen message="Открываем совместное прослушивание…" />;
    }
    if (!isAuthenticated) return null;

    return (
        <main
            data-utility-page="listen-together"
            className="min-h-screen px-4 py-6 md:px-8"
        >
            <div className="mx-auto w-full max-w-7xl">
                <PageHeader
                    title={listenTogetherRu.title}
                    subtitle={listenTogetherRu.subtitle}
                    icon={Users}
                    className="mb-6"
                />
                <AnimatePresence mode="wait">
                    {isLoading ? (
                        <motion.div
                            key="loading"
                            role="status"
                            aria-live="polite"
                            className="flex min-h-64 flex-col items-center justify-center rounded-3xl border border-line bg-surface-elevated py-16 motion-reduce:transform-none motion-reduce:transition-none"
                            {...fadeSlide}
                        >
                            <GradientSpinner size="lg" />
                            <p className="text-sm text-content-disabled mt-4">
                                {listenTogetherRu.loading}
                            </p>
                        </motion.div>
                    ) : view === "active" ? (
                        <ActiveGroupView key="active" />
                    ) : (
                        <LobbyView key="lobby" />
                    )}
                </AnimatePresence>
            </div>
        </main>
    );
}
