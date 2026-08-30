"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Inbox, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/utils/cn";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import type { MusicRequest } from "@/lib/api/requests";
import {
    REQUEST_FILTER_OPTIONS,
    canCancelRequest,
    canReviewRequest,
    filterRequestRows,
    requestStatusBadgeVariant,
    type MusicRequestFilter,
} from "@/lib/musicRequests";
import {
    formatPendingRequestsRu,
    formatRequestDateRu,
    libraryOperationsRu,
    requestFilterLabelRu,
    requestStatusLabelRu,
} from "@/lib/i18n/libraryOperationsRu";
import { userFacingError } from "@/lib/i18n/ru";
import {
    useCancelMusicRequest,
    useMusicRequestsAdmin,
    useMyMusicRequests,
    useReviewMusicRequest,
} from "@/hooks/useMusicRequests";

/** Deep link for a request's artist: local page when resolved, search otherwise. */
function requestArtistHref(request: MusicRequest): string {
    if (request.artistId) return `/artist/${request.artistId}`;
    return `/search?q=${encodeURIComponent(request.artistName)}`;
}

/** Deep link for a request's album: local page when resolved, search otherwise. */
function requestAlbumHref(request: MusicRequest): string {
    if (request.albumId) return `/album/${request.albumId}`;
    return `/search?q=${encodeURIComponent(
        `${request.artistName} ${request.albumTitle}`,
    )}`;
}

function RequestFilterPills(props: {
    filter: MusicRequestFilter;
    onChange: (value: MusicRequestFilter) => void;
}) {
    return (
        <div
            role="group"
            aria-label={libraryOperationsRu.requests.filterAria}
            className="flex flex-wrap items-center gap-1 rounded-full bg-white/5 p-1"
        >
            {REQUEST_FILTER_OPTIONS.map((option) => (
                <button
                    key={option.value}
                    onClick={() => props.onChange(option.value)}
                    className={cn(
                        "px-3 py-1.5 rounded-full text-xs font-medium transition-all",
                        props.filter === option.value
                            ? "bg-brand text-black"
                            : "text-gray-400 hover:text-white",
                    )}
                >
                    {requestFilterLabelRu(option.value)}
                </button>
            ))}
        </div>
    );
}

function ReviewActions(props: {
    busy: boolean;
    onApprove: () => void;
    onDeny: () => void;
}) {
    return (
        <div className="flex items-center gap-2">
            <button
                onClick={props.onApprove}
                disabled={props.busy}
                className="flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-black transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <Check className="h-3.5 w-3.5" />
                {libraryOperationsRu.requests.approve}
            </button>
            <button
                onClick={props.onDeny}
                disabled={props.busy}
                className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-all hover:bg-red-500/20 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <X className="h-3.5 w-3.5" />
                {libraryOperationsRu.requests.decline}
            </button>
        </div>
    );
}

function RequestRow(props: {
    request: MusicRequest;
    isAdmin: boolean;
    viewerId: string | undefined;
    busy: boolean;
    onApprove: (id: string) => void;
    onDeny: (id: string) => void;
    onCancel: (id: string) => void;
}) {
    const { request } = props;
    const showReview = canReviewRequest(request, props.isAdmin);
    const showCancel =
        !props.isAdmin && canCancelRequest(request, props.viewerId);
    return (
        <li className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">
                    <Link
                        href={requestArtistHref(request)}
                        className="hover:underline"
                    >
                        {request.artistName}
                    </Link>{" "}
                    —{" "}
                    <Link
                        href={requestAlbumHref(request)}
                        className="hover:underline"
                    >
                        {request.albumTitle}
                    </Link>
                </p>
                <p className="truncate text-xs text-gray-400">
                    {props.isAdmin && request.user
                        ? `${libraryOperationsRu.requests.requestedBy} ${request.user.username} · `
                        : ""}
                    {formatRequestDateRu(request.createdAt)}
                    {request.note ? ` · “${request.note}”` : ""}
                    {request.status === "denied" && request.deniedReason
                        ? ` · ${libraryOperationsRu.requests.declinedReason} ${request.deniedReason}`
                        : ""}
                </p>
            </div>
            <Badge variant={requestStatusBadgeVariant(request.status)}>
                {requestStatusLabelRu(request.status)}
            </Badge>
            {showReview && (
                <ReviewActions
                    busy={props.busy}
                    onApprove={() => props.onApprove(request.id)}
                    onDeny={() => props.onDeny(request.id)}
                />
            )}
            {showCancel && (
                <button
                    onClick={() => props.onCancel(request.id)}
                    disabled={props.busy}
                    className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-all hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {libraryOperationsRu.requests.cancel}
                </button>
            )}
        </li>
    );
}

function EmptyState(props: { isAdmin: boolean; filtered: boolean }) {
    return (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center">
            <Inbox className="h-8 w-8 text-white/30" />
            <p className="text-sm text-gray-400">
                {props.filtered
                    ? libraryOperationsRu.requests.filteredEmpty
                    : props.isAdmin
                      ? libraryOperationsRu.requests.adminEmpty
                      : libraryOperationsRu.requests.userEmpty}
            </p>
            {!props.isAdmin && (
                <Link
                    href="/library"
                    className="text-sm font-medium text-brand hover:underline"
                >
                    {libraryOperationsRu.requests.browseLibrary}
                </Link>
            )}
        </div>
    );
}

/** Toast-wrapped approve/deny/cancel actions shared by the request rows. */
function useRequestActions() {
    const review = useReviewMusicRequest();
    const cancel = useCancelMusicRequest();

    const act = (
        id: string,
        action: "approve" | "deny" | "cancel",
        messages: { loading: string; success: string },
    ) => {
        const toastId = `request-${action}-${id}`;
        toast.loading(messages.loading, { id: toastId });
        const promise =
            action === "cancel"
                ? cancel.mutateAsync(id)
                : review.mutateAsync({ id, action });
        promise
            .then(() => toast.success(messages.success, { id: toastId }))
            .catch((error: unknown) =>
                toast.error(
                    userFacingError(
                        error,
                        libraryOperationsRu.requests.actionFailed,
                    ),
                    { id: toastId },
                ),
            );
    };

    return {
        busy: review.isPending || cancel.isPending,
        onApprove: (id: string) =>
            act(id, "approve", {
                loading: libraryOperationsRu.requests.approveLoading,
                success: libraryOperationsRu.requests.approveSuccess,
            }),
        onDeny: (id: string) =>
            act(id, "deny", {
                loading: libraryOperationsRu.requests.declineLoading,
                success: libraryOperationsRu.requests.declineSuccess,
            }),
        onCancel: (id: string) =>
            act(id, "cancel", {
                loading: libraryOperationsRu.requests.cancelLoading,
                success: libraryOperationsRu.requests.cancelSuccess,
            }),
    };
}

function RequestList(props: {
    rows: MusicRequest[];
    isAdmin: boolean;
    viewerId: string | undefined;
}) {
    const actions = useRequestActions();
    return (
        <ul className="space-y-2">
            {props.rows.map((request) => (
                <RequestRow
                    key={request.id}
                    request={request}
                    isAdmin={props.isAdmin}
                    viewerId={props.viewerId}
                    busy={actions.busy}
                    onApprove={actions.onApprove}
                    onDeny={actions.onDeny}
                    onCancel={actions.onCancel}
                />
            ))}
        </ul>
    );
}

/** Role-aware request queue: admins review everything, users see their own. */
export default function RequestsPage() {
    const { user, isAuthenticated, isLoading: authLoading } = useAuth();
    const isAdmin = user?.role === "admin";
    const [filter, setFilter] = useState<MusicRequestFilter>("all");

    const adminQuery = useMusicRequestsAdmin(
        "all",
        Boolean(isAuthenticated) && isAdmin,
    );
    const mineQuery = useMyMusicRequests(Boolean(isAuthenticated) && !isAdmin);

    if (authLoading) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <GradientSpinner size="md" />
            </div>
        );
    }
    if (!isAuthenticated) return null;

    const activeQuery = isAdmin ? adminQuery : mineQuery;
    const rows = filterRequestRows(activeQuery.data ?? [], filter);
    const pendingCount = (activeQuery.data ?? []).filter(
        (request) => request.status === "pending",
    ).length;

    return (
        <div className="min-h-screen px-4 py-6 md:px-8">
            <PageHeader
                title={
                    isAdmin
                        ? libraryOperationsRu.requests.title
                        : libraryOperationsRu.requests.myTitle
                }
                subtitle={
                    isAdmin
                        ? libraryOperationsRu.requests.adminSubtitle
                        : libraryOperationsRu.requests.userSubtitle
                }
                icon={Inbox}
                badge={
                    pendingCount > 0 ? (
                        <Badge variant="warning">
                            {formatPendingRequestsRu(pendingCount)}
                        </Badge>
                    ) : null
                }
                actions={
                    <RequestFilterPills filter={filter} onChange={setFilter} />
                }
            />
            <div className="mx-auto mt-6 max-w-4xl">
                {activeQuery.isLoading ? (
                    <div className="flex justify-center py-16">
                        <GradientSpinner size="md" />
                    </div>
                ) : rows.length === 0 ? (
                    <EmptyState isAdmin={isAdmin} filtered={filter !== "all"} />
                ) : (
                    <RequestList
                        rows={rows}
                        isAdmin={isAdmin}
                        viewerId={user?.id}
                    />
                )}
            </div>
        </div>
    );
}
