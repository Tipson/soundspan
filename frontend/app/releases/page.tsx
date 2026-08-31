"use client";

import { useState, useEffect } from "react";
import {
    Calendar,
    Clock,
    Download,
    Music2,
    Disc,
    ArrowRight,
    CheckCircle2,
    Loader2,
    Send,
    RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useDownloadContext } from "@/lib/download-context";
import {
    openRequestRgMbids,
    useCreateMusicRequest,
    useMyMusicRequests,
    useRequestsGate,
} from "@/hooks/useMusicRequests";
import { api } from "@/lib/api";
import Link from "next/link";
import Image from "next/image";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    formatDownloadingReleaseRu,
    formatDownloadStartedRu,
    formatReleaseCalendarDateRu,
    formatReleaseRadarSummaryRu,
    formatReleaseRequestedRu,
    formatRelativeReleaseDateRu,
    formatRequestingReleaseRu,
    libraryOperationsRu,
} from "@/lib/i18n/libraryOperationsRu";
import { userFacingError } from "@/lib/i18n/ru";

interface ReleaseItem {
    id: number | string;
    title: string;
    artistName: string;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    source: "lidarr" | "similar";
    status: "upcoming" | "released" | "available";
    inLibrary: boolean;
    canDownload: boolean;
}

interface ReleaseRadarData {
    upcoming: ReleaseItem[];
    recent: ReleaseItem[];
    monitoredArtistCount: number;
    similarArtistCount: number;
}

/**
 * Renders the ReleasesPage component.
 */
export default function ReleasesPage() {
    const [data, setData] = useState<ReleaseRadarData | null>(null);
    const [loading, setLoading] = useState(true);
    const [downloadingId, setDownloadingId] = useState<string | number | null>(
        null,
    );
    const [error, setError] = useState<string | null>(null);
    const { downloadsEnabled } = useDownloadContext();
    const { requestsEnabled } = useRequestsGate();
    const myRequests = useMyMusicRequests(requestsEnabled);
    const createRequest = useCreateMusicRequest();
    const requestedRgMbids = openRequestRgMbids(myRequests.data);

    const fetchReleases = async () => {
        try {
            setLoading(true);
            setError(null);
            const json = await api.request<ReleaseRadarData>(
                "/releases/radar?daysBack=30&daysAhead=90",
                { timeoutMs: 20_000 },
            );
            setData(json);
        } catch (err: unknown) {
            setError(
                userFacingError(err, libraryOperationsRu.releases.loadFailed),
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchReleases();
    }, []);

    const handleAcquire = async (release: ReleaseItem) => {
        const toastId = `release-acquire-${release.id}`;
        try {
            setDownloadingId(release.id);
            if (downloadsEnabled) {
                toast.loading(formatDownloadingReleaseRu(release.title), {
                    id: toastId,
                });
                await api.downloadAlbum(
                    release.artistName,
                    release.title,
                    release.albumMbid,
                );
                toast.success(formatDownloadStartedRu(release.title), {
                    id: toastId,
                });
                await fetchReleases();
                return;
            }
            toast.loading(formatRequestingReleaseRu(release.title), {
                id: toastId,
            });
            await createRequest.mutateAsync({
                artistName: release.artistName,
                albumTitle: release.title,
                rgMbid: release.albumMbid,
                ...(release.artistMbid
                    ? { artistMbid: release.artistMbid }
                    : {}),
            });
            toast.success(formatReleaseRequestedRu(release.title), {
                id: toastId,
            });
        } catch (err) {
            sharedFrontendLogger.error("Release acquisition failed:", err);
            toast.error(
                userFacingError(err, libraryOperationsRu.releases.actionFailed),
                { id: toastId },
            );
        } finally {
            setDownloadingId(null);
        }
    };

    return (
        <main
            data-utility-page="releases"
            className="min-h-screen px-4 py-6 md:px-8"
        >
            <div className="mx-auto w-full max-w-7xl">
                <PageHeader
                    title={libraryOperationsRu.releases.heading}
                    subtitle={
                        data
                            ? formatReleaseRadarSummaryRu(
                                  data.monitoredArtistCount || 0,
                                  data.upcoming.length || 0,
                                  data.recent.length || 0,
                              )
                            : "Следите за новинками исполнителей из вашей коллекции."
                    }
                    icon={Calendar}
                    badge={
                        <span className="rounded-full border border-line bg-surface-elevated px-3 py-1 text-xs font-semibold text-content-muted">
                            {libraryOperationsRu.releases.title}
                        </span>
                    }
                />

                {loading ? (
                    <div
                        role="status"
                        aria-live="polite"
                        className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-3xl border border-line bg-surface-elevated text-content-muted"
                    >
                        <GradientSpinner size="md" />
                        <p className="text-sm font-medium">Загружаем релизы…</p>
                    </div>
                ) : error ? (
                    <div
                        role="alert"
                        className="flex min-h-64 flex-col items-center justify-center rounded-3xl border border-error/25 bg-error/5 px-5 py-12 text-center"
                    >
                        <span className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-error/10 text-error">
                            <Music2 className="size-7" aria-hidden="true" />
                        </span>
                        <h2 className="text-lg font-semibold text-content">
                            {libraryOperationsRu.releases.loadFailed}
                        </h2>
                        <p className="mt-2 max-w-md text-sm leading-6 text-content-muted">
                            {error}
                        </p>
                        <Button
                            variant="secondary"
                            className="mt-5"
                            onClick={() => void fetchReleases()}
                        >
                            <RefreshCw className="size-4" aria-hidden="true" />
                            Повторить
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-10">
                        {/* Upcoming Releases */}
                        {data?.upcoming && data.upcoming.length > 0 && (
                            <section aria-labelledby="upcoming-releases-heading">
                                <div className="mb-5 flex items-center gap-3">
                                    <span className="flex size-10 items-center justify-center rounded-xl bg-warning/10 text-warning">
                                        <Clock
                                            className="size-5"
                                            aria-hidden="true"
                                        />
                                    </span>
                                    <h2
                                        id="upcoming-releases-heading"
                                        className="text-xl font-semibold text-content"
                                    >
                                        {
                                            libraryOperationsRu.releases
                                                .comingSoon
                                        }
                                    </h2>
                                    <span className="text-sm tabular-nums text-content-muted">
                                        ({data.upcoming.length})
                                    </span>
                                </div>

                                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(8rem,100%),1fr))] gap-4 sm:gap-5">
                                    {data.upcoming.map((release) => (
                                        <ReleaseCard
                                            key={`${release.albumMbid}-${release.id}`}
                                            release={release}
                                            formatDate={
                                                formatRelativeReleaseDateRu
                                            }
                                            onAcquire={handleAcquire}
                                            isDownloading={
                                                downloadingId === release.id
                                            }
                                            mode={
                                                downloadsEnabled
                                                    ? "download"
                                                    : requestsEnabled
                                                      ? "request"
                                                      : "none"
                                            }
                                            isRequested={requestedRgMbids.has(
                                                release.albumMbid.toLowerCase(),
                                            )}
                                        />
                                    ))}
                                </div>
                            </section>
                        )}

                        {/* Recently Released */}
                        {data?.recent && data.recent.length > 0 && (
                            <section aria-labelledby="recent-releases-heading">
                                <div className="mb-5 flex items-center gap-3">
                                    <span className="flex size-10 items-center justify-center rounded-xl bg-success/10 text-success">
                                        <Disc
                                            className="size-5"
                                            aria-hidden="true"
                                        />
                                    </span>
                                    <h2
                                        id="recent-releases-heading"
                                        className="text-xl font-semibold text-content"
                                    >
                                        {
                                            libraryOperationsRu.releases
                                                .justDropped
                                        }
                                    </h2>
                                    <span className="text-sm tabular-nums text-content-muted">
                                        ({data.recent.length})
                                    </span>
                                </div>

                                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(8rem,100%),1fr))] gap-4 sm:gap-5">
                                    {data.recent.map((release) => (
                                        <ReleaseCard
                                            key={`${release.albumMbid}-${release.id}`}
                                            release={release}
                                            formatDate={
                                                formatRelativeReleaseDateRu
                                            }
                                            onAcquire={handleAcquire}
                                            isDownloading={
                                                downloadingId === release.id
                                            }
                                            mode={
                                                downloadsEnabled
                                                    ? "download"
                                                    : requestsEnabled
                                                      ? "request"
                                                      : "none"
                                            }
                                            isRequested={requestedRgMbids.has(
                                                release.albumMbid.toLowerCase(),
                                            )}
                                        />
                                    ))}
                                </div>
                            </section>
                        )}

                        {/* Empty State */}
                        {!data?.upcoming?.length && !data?.recent?.length && (
                            <EmptyState
                                icon={
                                    <Calendar
                                        className="size-7"
                                        aria-hidden="true"
                                    />
                                }
                                title={libraryOperationsRu.releases.emptyTitle}
                                description={
                                    libraryOperationsRu.releases
                                        .emptyDescription
                                }
                            >
                                <Link
                                    href="/settings"
                                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-surface transition-colors hover:bg-brand-hover"
                                >
                                    {
                                        libraryOperationsRu.releases
                                            .configureLidarr
                                    }
                                    <ArrowRight
                                        className="size-4"
                                        aria-hidden="true"
                                    />
                                </Link>
                            </EmptyState>
                        )}
                    </div>
                )}
            </div>
        </main>
    );
}

function ReleaseCard({
    release,
    formatDate,
    onAcquire,
    isDownloading,
    mode,
    isRequested,
}: {
    release: ReleaseItem;
    formatDate: (date: string) => string;
    onAcquire: (release: ReleaseItem) => void;
    isDownloading: boolean;
    mode: "download" | "request" | "none";
    isRequested: boolean;
}) {
    const isUpcoming = release.status === "upcoming";
    const hasIt = release.inLibrary;

    return (
        <article className="group relative min-w-0">
            {/* Cover Art */}
            <div className="relative mb-3 aspect-square overflow-hidden rounded-2xl border border-line bg-surface-elevated">
                {release.coverUrl ? (
                    <Image
                        src={release.coverUrl}
                        alt={release.title}
                        fill
                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, 16vw"
                        className="object-cover transition-transform duration-300 motion-reduce:transition-none sm:group-hover:scale-[1.03]"
                        unoptimized
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center">
                        <Disc className="size-12 text-content-disabled" />
                    </div>
                )}

                {/* Status Badge */}
                <div
                    className={cn(
                        "absolute left-2 top-2 rounded-full border px-2.5 py-1 text-[11px] font-semibold backdrop-blur-md",
                        isUpcoming
                            ? "border-warning/30 bg-surface/85 text-warning"
                            : hasIt
                              ? "border-success/30 bg-surface/85 text-success"
                              : "border-line bg-surface/85 text-content",
                    )}
                >
                    {isUpcoming
                        ? formatDate(release.releaseDate)
                        : hasIt
                          ? libraryOperationsRu.releases.inLibrary
                          : libraryOperationsRu.releases.available}
                </div>

                {/* Acquire Overlay: admins download, everyone else requests */}
                {mode !== "none" && release.canDownload && !hasIt && (
                    <button
                        onClick={() => onAcquire(release)}
                        disabled={isDownloading || isRequested}
                        title={
                            isRequested
                                ? libraryOperationsRu.releases.alreadyRequested
                                : mode === "download"
                                  ? libraryOperationsRu.releases.downloadRelease
                                  : libraryOperationsRu.releases.requestRelease
                        }
                        aria-label={
                            isRequested
                                ? libraryOperationsRu.releases.alreadyRequested
                                : mode === "download"
                                  ? libraryOperationsRu.releases.downloadRelease
                                  : libraryOperationsRu.releases.requestRelease
                        }
                        className={cn(
                            "absolute bottom-2 right-2 flex size-11 items-center justify-center rounded-full border border-line bg-surface/90 text-content shadow-lg backdrop-blur-md transition-[color,background-color,opacity,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover disabled:cursor-not-allowed",
                            "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
                            (isDownloading || isRequested) &&
                                "opacity-100 sm:opacity-100",
                        )}
                    >
                        {isDownloading ? (
                            <Loader2 className="size-5 animate-spin motion-reduce:animate-none" />
                        ) : isRequested ? (
                            <CheckCircle2 className="size-5 text-success" />
                        ) : mode === "download" ? (
                            <Download className="size-5" />
                        ) : (
                            <Send className="size-5" />
                        )}
                    </button>
                )}

                {/* In Library Indicator */}
                {hasIt && (
                    <div className="absolute bottom-2 right-2">
                        <CheckCircle2 className="size-5 text-success" />
                    </div>
                )}
            </div>

            {/* Info */}
            <div className="space-y-1">
                <h3
                    className="truncate text-sm font-semibold text-content"
                    title={release.title}
                >
                    {release.title}
                </h3>
                <p
                    className="truncate text-xs text-content-muted"
                    title={release.artistName}
                >
                    {release.artistName}
                </p>
                {isUpcoming && (
                    <p className="text-xs font-medium text-warning">
                        {formatReleaseCalendarDateRu(release.releaseDate)}
                    </p>
                )}
            </div>
        </article>
    );
}
