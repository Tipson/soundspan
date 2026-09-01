"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Inbox, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/utils/cn";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
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
            className="flex flex-wrap items-center gap-1 rounded-2xl border border-line bg-surface-elevated p-1"
        >
            {REQUEST_FILTER_OPTIONS.map((option) => (
                <button
                    key={option.value}
                    onClick={() => props.onChange(option.value)}
                    aria-pressed={props.filter === option.value}
                    className={cn(
                        "min-h-11 rounded-full px-3.5 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover",
                        props.filter === option.value
                            ? "bg-brand text-surface"
                            : "text-content-muted hover:bg-surface-hover hover:text-content",
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
            <Button
                variant="primary"
                onClick={props.onApprove}
                disabled={props.busy}
                className="rounded-full px-3.5 text-xs"
            >
                <Check className="h-3.5 w-3.5" />
                {libraryOperationsRu.requests.approve}
            </Button>
            <Button
                variant="secondary"
                onClick={props.onDeny}
                disabled={props.busy}
                className="rounded-full px-3.5 text-xs hover:border-error/30 hover:bg-error/10 hover:text-error"
            >
                <X className="h-3.5 w-3.5" />
                {libraryOperationsRu.requests.decline}
            </Button>
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
        <li className="flex flex-col gap-3 rounded-2xl border border-line bg-surface-elevated px-4 py-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-content">
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
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-content-muted sm:truncate">
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
                <Button
                    variant="secondary"
                    onClick={() => props.onCancel(request.id)}
                    disabled={props.busy}
                    className="w-full rounded-full px-3.5 text-xs sm:w-auto"
                >
                    {libraryOperationsRu.requests.cancel}
                </Button>
            )}
        </li>
    );
}

function RequestEmptyState(props: { isAdmin: boolean; filtered: boolean }) {
    const description = props.filtered
        ? libraryOperationsRu.requests.filteredEmpty
        : props.isAdmin
          ? libraryOperationsRu.requests.adminEmpty
          : libraryOperationsRu.requests.userEmpty;

    return (
        <EmptyState
            icon={<Inbox className="size-7" aria-hidden="true" />}
            title={
                props.filtered
                    ? "По этому фильтру ничего нет"
                    : props.isAdmin
                      ? "Очередь запросов пуста"
                      : "Запросов пока нет"
            }
            description={description}
        >
            {!props.isAdmin && (
                <Link
                    href="/library"
                    className="inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-surface-elevated px-5 py-2.5 text-sm font-semibold text-content transition-colors hover:bg-surface-hover"
                >
                    {libraryOperationsRu.requests.browseLibrary}
                </Link>
            )}
        </EmptyState>
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
        return <LoadingScreen message="Загружаем запросы…" />;
    }
    if (!isAuthenticated) return null;

    const activeQuery = isAdmin ? adminQuery : mineQuery;
    const rows = filterRequestRows(activeQuery.data ?? [], filter);
    const pendingCount = (activeQuery.data ?? []).filter(
        (request) => request.status === "pending",
    ).length;

    return (
        <main
            data-utility-page="requests"
            className="min-h-screen px-4 py-6 md:px-8"
        >
            <div className="mx-auto w-full max-w-6xl">
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
                        <RequestFilterPills
                            filter={filter}
                            onChange={setFilter}
                        />
                    }
                />
                {activeQuery.isLoading ? (
                    <div
                        role="status"
                        aria-live="polite"
                        className="flex flex-col items-center justify-center gap-3 py-16 text-content-muted"
                    >
                        <GradientSpinner size="md" />
                        <span className="text-sm">Загружаем запросы…</span>
                    </div>
                ) : activeQuery.isError ? (
                    <div
                        role="alert"
                        className="flex flex-col items-start gap-4 rounded-2xl border border-error/25 bg-error/5 p-5 sm:flex-row sm:items-center"
                    >
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-error/10 text-error">
                            <AlertTriangle
                                className="size-5"
                                aria-hidden="true"
                            />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h2 className="font-semibold text-content">
                                Не удалось загрузить запросы
                            </h2>
                            <p className="mt-1 text-sm leading-6 text-content-muted">
                                Проверьте соединение и попробуйте ещё раз.
                            </p>
                        </div>
                        <Button
                            variant="secondary"
                            className="w-full sm:w-auto"
                            onClick={() => void activeQuery.refetch()}
                        >
                            <RefreshCw className="size-4" aria-hidden="true" />
                            Повторить
                        </Button>
                    </div>
                ) : rows.length === 0 ? (
                    <RequestEmptyState
                        isAdmin={isAdmin}
                        filtered={filter !== "all"}
                    />
                ) : (
                    <RequestList
                        rows={rows}
                        isAdmin={isAdmin}
                        viewerId={user?.id}
                    />
                )}
            </div>
        </main>
    );
}
