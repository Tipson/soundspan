"use client";

import Image from "next/image";
import Link from "next/link";
import { Music2, Users } from "lucide-react";
import { cn } from "@/utils/cn";
import {
    useSocialPresence,
    type SocialOnlineUser,
} from "@/hooks/useSocialPresence";
import { PeerPresenceSection } from "@/components/activity/PeerPresenceSection";
import { api } from "@/lib/api";
import {
    adminActivityRu,
    formatActivityRelativeTime,
} from "@/lib/i18n/adminActivityRu";
import { pluralRu } from "@/lib/i18n/ru";

function getListeningStatusDisplay(
    status: SocialOnlineUser["listeningStatus"],
) {
    switch (status) {
        case "playing":
            return {
                label: adminActivityRu.activity.social.statuses.playing,
                badgeClass:
                    "text-green-300 border-green-400/30 bg-green-400/10",
                dotClass: "bg-green-400",
            };
        case "paused":
            return {
                label: adminActivityRu.activity.social.statuses.paused,
                badgeClass:
                    "text-amber-300 border-amber-400/30 bg-amber-400/10",
                dotClass: "bg-amber-400",
            };
        case "idle":
        default:
            return {
                label: adminActivityRu.activity.social.statuses.idle,
                badgeClass: "text-white/50 border-white/15 bg-white/5",
                dotClass: "bg-white/40",
            };
    }
}

interface SocialTabProps {
    users?: SocialOnlineUser[];
    isLoading?: boolean;
    error?: unknown;
    queryEnabled?: boolean;
}

/**
 * Renders the SocialTab component.
 */
export function SocialTab({
    users: usersProp,
    isLoading: isLoadingProp,
    error: errorProp,
    queryEnabled = true,
}: SocialTabProps = {}) {
    const socialQuery = useSocialPresence({ enabled: queryEnabled });
    const users = usersProp ?? socialQuery.users;
    const peers = socialQuery.peers ?? [];
    const isLoading = isLoadingProp ?? socialQuery.isLoading;
    const error = errorProp ?? socialQuery.error;
    const hasPeerUsers = peers.some((peer) => peer.users.length > 0);
    const hasUsers = users.length > 0 || hasPeerUsers;
    const showLoadingState = isLoading && !hasUsers;
    const showUnavailableState = Boolean(error) && !hasUsers;

    if (showLoadingState) {
        return (
            <div
                className="flex items-center justify-center py-8"
                role="status"
                aria-label={adminActivityRu.activity.loading}
            >
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (showUnavailableState) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center px-6">
                <Users className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">
                    {adminActivityRu.activity.social.unavailable}
                </p>
                <p className="text-xs text-white/30 mt-1">
                    {adminActivityRu.activity.social.unavailableHint}
                </p>
            </div>
        );
    }

    if (!hasUsers) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">
                    {adminActivityRu.activity.social.empty}
                </p>
                <p className="text-xs text-white/30 mt-1">
                    {adminActivityRu.activity.social.emptyHint}
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span
                    className="text-xs text-white/40"
                    role="status"
                    aria-live="polite"
                >
                    {users.length}{" "}
                    {pluralRu(users.length, [
                        "пользователь онлайн",
                        "пользователя онлайн",
                        "пользователей онлайн",
                    ])}
                    {hasPeerUsers && (
                        <>
                            {" · "}
                            {peers.reduce(
                                (total, peer) => total + peer.users.length,
                                0,
                            )}{" "}
                            на других серверах
                        </>
                    )}
                </span>
                <span className="text-xs text-green-400 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    {adminActivityRu.activity.social.live}
                </span>
            </div>

            <div
                className="flex-1 overflow-y-auto"
                role="list"
                aria-label={adminActivityRu.activity.social.onlineUsersAria}
            >
                {users.map((user) => {
                    const listeningStatus = getListeningStatusDisplay(
                        user.listeningStatus,
                    );
                    const track = user.listeningTrack;
                    const showTrack =
                        user.listeningStatus !== "idle" && Boolean(track);
                    const songHref =
                        showTrack && track?.albumId
                            ? `/album/${encodeURIComponent(track.albumId)}`
                            : null;
                    const artistHref =
                        showTrack && track?.artistId
                            ? `/artist/${encodeURIComponent(track.artistId)}`
                            : null;

                    return (
                        <div
                            key={user.id}
                            role="listitem"
                            tabIndex={0}
                            className="px-3 py-3 border-b border-white/5 hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/50 focus-visible:bg-white/5"
                        >
                            <div className="flex items-start gap-3">
                                <div className="w-8 h-8 rounded-full bg-white/10 text-white/80 text-xs font-semibold flex items-center justify-center shrink-0 overflow-hidden">
                                    {user.hasProfilePicture ? (
                                        <Image
                                            src={api.getProfilePictureUrl(
                                                user.id,
                                            )}
                                            alt={user.displayName}
                                            width={32}
                                            height={32}
                                            className="w-full h-full object-cover"
                                            unoptimized
                                        />
                                    ) : (
                                        user.displayName.charAt(0).toUpperCase()
                                    )}
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium text-white truncate">
                                            {user.displayName}
                                        </p>
                                        <span
                                            className={cn(
                                                "inline-flex items-center gap-1 text-[10px] uppercase tracking-wide rounded border px-1.5 py-0.5",
                                                listeningStatus.badgeClass,
                                            )}
                                            title={`${adminActivityRu.activity.social.listeningStatus}: ${listeningStatus.label}`}
                                        >
                                            <span
                                                className={cn(
                                                    "w-1.5 h-1.5 rounded-full",
                                                    listeningStatus.dotClass,
                                                )}
                                            />
                                            {listeningStatus.label}
                                        </span>
                                        {user.isInListenTogetherGroup && (
                                            <span
                                                className="inline-flex items-center justify-center font-bold rounded text-[9px] px-1 py-0.5 leading-none bg-ai/20 text-ai-hover"
                                                title={
                                                    adminActivityRu.activity
                                                        .social.listenTogether
                                                }
                                                aria-label={
                                                    adminActivityRu.activity
                                                        .social.listenTogether
                                                }
                                            >
                                                <Users className="w-2.5 h-2.5" />
                                            </span>
                                        )}
                                    </div>

                                    {user.displayName !== user.username && (
                                        <p className="text-xs text-white/40 truncate">
                                            @{user.username}
                                        </p>
                                    )}

                                    {showTrack && track ? (
                                        <p className="text-xs text-brand truncate mt-1 flex items-center gap-1.5">
                                            {track.coverArt ? (
                                                <span className="relative w-3.5 h-3.5 shrink-0 overflow-hidden rounded-[2px]">
                                                    <Image
                                                        src={api.getCoverArtUrl(
                                                            track.coverArt,
                                                            32,
                                                        )}
                                                        alt=""
                                                        fill
                                                        sizes="14px"
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                </span>
                                            ) : (
                                                <Music2 className="w-3 h-3 shrink-0" />
                                            )}
                                            <span className="truncate">
                                                {songHref ? (
                                                    <Link
                                                        href={songHref}
                                                        className="hover:underline"
                                                    >
                                                        {track.title}
                                                    </Link>
                                                ) : (
                                                    track.title
                                                )}
                                            </span>
                                            <span className="text-white/40 shrink-0">
                                                •
                                            </span>
                                            <span className="text-white/60 truncate">
                                                {artistHref ? (
                                                    <Link
                                                        href={artistHref}
                                                        className="hover:underline"
                                                    >
                                                        {track.artistName}
                                                    </Link>
                                                ) : (
                                                    track.artistName
                                                )}
                                            </span>
                                        </p>
                                    ) : (
                                        <p className="text-xs text-white/35 mt-1 flex items-center gap-1.5">
                                            <span className="w-2 h-2 rounded-full bg-white/40 shrink-0" />
                                            {
                                                adminActivityRu.activity.social
                                                    .notPlaying
                                            }
                                        </p>
                                    )}
                                </div>

                                <div
                                    className={cn(
                                        "text-[11px] text-white/30 shrink-0 pt-0.5",
                                        user.listeningTrack && "text-white/40",
                                    )}
                                    title={new Date(
                                        user.lastHeartbeatAt,
                                    ).toLocaleString("ru-RU")}
                                >
                                    {formatActivityRelativeTime(
                                        user.lastHeartbeatAt,
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
                <PeerPresenceSection peers={peers} />
            </div>
        </div>
    );
}
