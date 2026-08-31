"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Music2, Sparkles } from "lucide-react";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useAudioState, usePlaybackStatus } from "@/lib/audio-context";
import { useDiscoverData } from "@/features/discover/hooks/useDiscoverData";
import { useDiscoverActions } from "@/features/discover/hooks/useDiscoverActions";
import { useDiscoverProviderGapFill } from "@/features/discover/hooks/useDiscoverProviderGapFill";
import { usePreviewPlayer } from "@/features/discover/hooks/usePreviewPlayer";
import { DiscoverHero } from "@/features/discover/components/DiscoverHero";
import { DiscoverActionBar } from "@/features/discover/components/DiscoverActionBar";
import { DiscoverSettings } from "@/features/discover/components/DiscoverSettings";
import { TrackList } from "@/features/discover/components/TrackList";
import { UnavailableAlbums } from "@/features/discover/components/UnavailableAlbums";
import { HowItWorks } from "@/features/discover/components/HowItWorks";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { useFeatures } from "@/lib/features-context";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { discoverAddedCount, discoverRu } from "@/lib/i18n/discoverRu";

const DISCOVER_RECENT_GENERATION_WINDOW_MS = 45 * 60 * 1000;
const DISCOVER_RECOVERY_MAX_ATTEMPTS = 4;
const DISCOVER_RECOVERY_RETRY_DELAY_MS = 2500;

/**
 * Renders the DiscoverWeeklyPage component.
 *
 * Hidden behind the discovery feature flag: when disabled, an empty state is
 * shown instead of fetching discover data.
 */
export default function DiscoverWeeklyPage() {
    const { discovery, loading: featuresLoading } = useFeatures();

    if (featuresLoading) {
        return <LoadingScreen message="Проверяем доступность подборки…" />;
    }

    if (!discovery) {
        return (
            <main
                data-utility-page="discover"
                className="min-h-screen px-4 py-6 md:px-8"
            >
                <div className="mx-auto w-full max-w-7xl">
                    <PageHeader
                        title={discoverRu.name}
                        subtitle={discoverRu.description}
                        icon={Sparkles}
                    />
                    <div className="rounded-3xl border border-line bg-surface-elevated">
                        <EmptyState
                            icon={
                                <Music2 className="size-7" aria-hidden="true" />
                            }
                            title={discoverRu.unavailableTitle}
                            description={discoverRu.unavailableHint}
                        />
                    </div>
                </div>
            </main>
        );
    }

    return <DiscoverWeeklyPageContent />;
}

function DiscoverWeeklyPageContent() {
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    const [showSettings, setShowSettings] = useState(false);
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [isAddingToPlaylist, setIsAddingToPlaylist] = useState(false);
    const [playlistRecoveryAttempts, setPlaylistRecoveryAttempts] = useState(0);

    // Custom hooks - single source of truth for batch status from useDiscoverData
    const {
        playlist,
        config,
        setConfig,
        loading,
        reloadData,
        batchStatus,
        refreshBatchStatus,
        setPendingGeneration,
        isGenerating,
    } = useDiscoverData();
    const {
        tracks: providerEnrichedTracks,
        providerCounts,
        isMatching,
    } = useDiscoverProviderGapFill(playlist?.tracks);
    const displayPlaylist = playlist
        ? { ...playlist, tracks: providerEnrichedTracks }
        : null;
    const {
        handleGenerate,
        handlePlayPlaylist,
        handleShufflePlaylist,
        handlePlayTrack,
        handleTogglePlay,
        handleAddAllToQueue,
    } = useDiscoverActions(
        displayPlaylist,
        isGenerating,
        refreshBatchStatus,
        setPendingGeneration,
    );
    const { currentPreview, handleTogglePreview } = usePreviewPlayer();
    const hasDiscoverTracks = Boolean(
        displayPlaylist && displayPlaylist.tracks.length > 0,
    );
    const hasUnavailableAlbums = Boolean(
        displayPlaylist && displayPlaylist.unavailable.length > 0,
    );
    const hasPlaylistContent = hasDiscoverTracks || hasUnavailableAlbums;
    const generatedRecently = useMemo(() => {
        if (!config?.lastGeneratedAt) return false;
        const generatedAtMs = new Date(config.lastGeneratedAt).getTime();
        if (!Number.isFinite(generatedAtMs)) return false;
        return (
            Date.now() - generatedAtMs <= DISCOVER_RECENT_GENERATION_WINDOW_MS
        );
    }, [config?.lastGeneratedAt]);
    const shouldRetryPlaylistHydration =
        !loading &&
        !hasPlaylistContent &&
        !isGenerating &&
        generatedRecently &&
        playlistRecoveryAttempts < DISCOVER_RECOVERY_MAX_ATTEMPTS;
    const shouldShowResolvingState =
        !loading &&
        !hasPlaylistContent &&
        (isGenerating || shouldRetryPlaylistHydration);

    // Check if we're playing from this playlist
    const isPlaylistPlaying = displayPlaylist?.tracks.some(
        (t) => t.id === currentTrack?.id,
    );

    useEffect(() => {
        if (!shouldRetryPlaylistHydration) return;
        const retryTimer = window.setTimeout(() => {
            setPlaylistRecoveryAttempts((attempts) => attempts + 1);
            void reloadData({ preservePlaylistOnError: true });
        }, DISCOVER_RECOVERY_RETRY_DELAY_MS);
        return () => {
            window.clearTimeout(retryTimer);
        };
    }, [shouldRetryPlaylistHydration, reloadData]);

    useEffect(() => {
        if (!hasPlaylistContent && generatedRecently) return;
        setPlaylistRecoveryAttempts(0);
    }, [hasPlaylistContent, generatedRecently]);

    const handleAddAllToPlaylist = () => {
        setShowPlaylistSelector(true);
    };

    const handlePlaylistSelected = async (playlistId: string) => {
        if (!displayPlaylist?.tracks.length) return;
        setIsAddingToPlaylist(true);
        try {
            for (const track of displayPlaylist.tracks) {
                await api.addTrackToPlaylist(
                    playlistId,
                    toAddToPlaylistRef(track),
                );
            }
            toast.success(discoverAddedCount(displayPlaylist.tracks.length));
            setShowPlaylistSelector(false);
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to add tracks to playlist:",
                error,
            );
            toast.error(discoverRu.toast.addFailed);
        } finally {
            setIsAddingToPlaylist(false);
        }
    };

    if (loading) {
        return (
            <main
                data-utility-page="discover"
                className="min-h-screen px-4 py-6 md:px-8"
            >
                <div className="mx-auto w-full max-w-7xl">
                    <DiscoverHero playlist={null} config={null} />
                    <div
                        role="status"
                        aria-live="polite"
                        className="mt-4 flex min-h-64 flex-col items-center justify-center gap-4 rounded-3xl border border-line bg-surface-elevated text-content-muted"
                    >
                        <GradientSpinner size="md" />
                        <p className="text-sm font-medium">
                            Загружаем подборку…
                        </p>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main
            data-utility-page="discover"
            className="min-h-screen px-4 py-6 md:px-8"
        >
            <div className="mx-auto w-full max-w-7xl">
                <DiscoverHero playlist={displayPlaylist} config={config} />

                <DiscoverActionBar
                    playlist={displayPlaylist}
                    config={config}
                    isPlaylistPlaying={isPlaylistPlaying || false}
                    isPlaying={isPlaying}
                    onPlayToggle={
                        isPlaylistPlaying && isPlaying
                            ? handleTogglePlay
                            : handlePlayPlaylist
                    }
                    onGenerate={handleGenerate}
                    onToggleSettings={() => setShowSettings(!showSettings)}
                    onAddToPlaylist={handleAddAllToPlaylist}
                    onShuffle={handleShufflePlaylist}
                    onAddAllToQueue={handleAddAllToQueue}
                    isGenerating={isGenerating}
                    batchStatus={batchStatus}
                />

                {showSettings && (
                    <div className="mt-4">
                        <DiscoverSettings
                            config={config}
                            onUpdateConfig={setConfig}
                            onPlaylistCleared={reloadData}
                        />
                    </div>
                )}

                {/* Track Listing */}
                <div className="mt-6">
                    {hasPlaylistContent ? (
                        <div className="space-y-6">
                            {hasDiscoverTracks ? (
                                <>
                                    <p className="rounded-xl border border-line bg-surface-elevated px-4 py-3 text-xs leading-5 text-content-muted">
                                        {discoverRu.sourceMix}:{" "}
                                        {providerCounts.local}{" "}
                                        {discoverRu.local}
                                        {providerCounts.tidal > 0
                                            ? ` • ${providerCounts.tidal} TIDAL — ${discoverRu.gapFill}`
                                            : ""}
                                        {providerCounts.youtube > 0
                                            ? ` • ${providerCounts.youtube} YouTube Music — ${discoverRu.gapFill}`
                                            : ""}
                                    </p>
                                    <TrackList
                                        tracks={displayPlaylist?.tracks || []}
                                        isMatching={isMatching}
                                        currentTrack={currentTrack}
                                        isPlaying={isPlaying}
                                        onPlayTrack={handlePlayTrack}
                                        onTogglePlay={handleTogglePlay}
                                    />
                                </>
                            ) : (
                                <p className="text-sm text-content-muted">
                                    {discoverRu.status.finishingList}
                                </p>
                            )}

                            <UnavailableAlbums
                                unavailable={displayPlaylist?.unavailable || []}
                                currentPreview={currentPreview}
                                onTogglePreview={handleTogglePreview}
                            />

                            <HowItWorks />
                        </div>
                    ) : shouldShowResolvingState ? (
                        <div
                            role="status"
                            aria-live="polite"
                            className="flex flex-col items-center justify-center rounded-3xl border border-line bg-surface-elevated px-5 py-16 text-center"
                        >
                            <GradientSpinner size="md" />
                            <h3 className="mt-4 text-lg font-semibold text-content">
                                {discoverRu.status.loadingLatest}
                            </h3>
                            <p className="mt-1 max-w-md text-sm leading-6 text-content-muted">
                                {discoverRu.status.loadingLatestHint}
                            </p>
                        </div>
                    ) : (
                        <div className="rounded-3xl border border-line bg-surface-elevated">
                            <EmptyState
                                icon={
                                    <Music2
                                        className="size-7"
                                        aria-hidden="true"
                                    />
                                }
                                title={discoverRu.status.emptyTitle}
                                description={discoverRu.status.emptyHint}
                            >
                                <Button
                                    variant="ai"
                                    onClick={handleGenerate}
                                    disabled={isGenerating}
                                >
                                    {isGenerating ? (
                                        <>
                                            <GradientSpinner size="sm" />
                                            {batchStatus?.status === "scanning"
                                                ? discoverRu.status.finalizing
                                                : batchStatus?.status ===
                                                    "generating"
                                                  ? discoverRu.status.refreshing
                                                  : `${discoverRu.status.working} ${batchStatus?.completed || 0}/${batchStatus?.total || 0}`}
                                        </>
                                    ) : (
                                        <>
                                            <RefreshCw
                                                className="size-5"
                                                aria-hidden="true"
                                            />
                                            {discoverRu.action.generateNow}
                                        </>
                                    )}
                                </Button>
                            </EmptyState>
                        </div>
                    )}
                </div>
            </div>

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => setShowPlaylistSelector(false)}
                onSelectPlaylist={handlePlaylistSelected}
                isLoading={isAddingToPlaylist}
                loadingMessage={discoverRu.toast.adding}
            />
        </main>
    );
}
