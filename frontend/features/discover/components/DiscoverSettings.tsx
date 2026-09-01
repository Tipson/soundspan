"use client";

import { useState, useRef } from "react";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Trash2, Loader2 } from "lucide-react";
import type { DiscoverConfig } from "../types";
import {
    discoverMonthCount,
    discoverRemovedCount,
    discoverRu,
    discoverTrackCount,
} from "@/lib/i18n/discoverRu";

interface DiscoverSettingsProps {
    config: DiscoverConfig | null;
    onUpdateConfig: (updatedConfig: DiscoverConfig | null) => void;
    onPlaylistCleared?: () => void;
}

/**
 * Renders the DiscoverSettings component.
 */
export function DiscoverSettings({
    config,
    onUpdateConfig,
    onPlaylistCleared,
}: DiscoverSettingsProps) {
    const [isClearing, setIsClearing] = useState(false);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const debounceRef = useRef<NodeJS.Timeout | null>(null);

    // Generic handler for config changes with debounce
    function handleConfigChange<K extends keyof DiscoverConfig>(
        key: K,
        value: DiscoverConfig[K],
    ) {
        // Update local state immediately for responsive UI
        if (config) {
            onUpdateConfig({ ...config, [key]: value });
        }

        // Debounce the API call
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
        }
        debounceRef.current = setTimeout(async () => {
            try {
                await api.updateDiscoverConfig({ [key]: value });
            } catch {
                toast.error(discoverRu.toast.settingSaveFailed);
            }
        }, 500);
    }

    async function confirmClearPlaylist() {
        setIsClearing(true);
        try {
            const result = await api.clearDiscoverPlaylist();

            if (result.activeDeleted > 0) {
                toast.success(discoverRemovedCount(result.activeDeleted));
            } else {
                toast.info(discoverRu.toast.nothingToClear);
            }

            onPlaylistCleared?.();
        } catch {
            toast.error(discoverRu.toast.clearFailed);
        } finally {
            setIsClearing(false);
        }
    }

    return (
        <div>
            <Card className="rounded-2xl border-line bg-surface-elevated p-5 sm:p-6">
                <h2 className="mb-5 text-xl font-semibold text-content">
                    {discoverRu.settings.title}
                </h2>
                <div className="space-y-6">
                    <div>
                        <label
                            htmlFor="discover-playlist-size"
                            className="mb-1 block text-sm font-semibold text-content"
                        >
                            {discoverRu.settings.playlistSize}:{" "}
                            {discoverTrackCount(config?.playlistSize || 10)}
                        </label>
                        <input
                            id="discover-playlist-size"
                            type="range"
                            min="5"
                            max="50"
                            step="5"
                            value={config?.playlistSize || 10}
                            onChange={(e) =>
                                handleConfigChange(
                                    "playlistSize",
                                    parseInt(e.target.value),
                                )
                            }
                            className="h-11 w-full cursor-pointer appearance-none rounded-lg bg-transparent accent-brand [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-surface-active [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand"
                        />
                        <p className="text-xs leading-5 text-content-muted">
                            {discoverRu.settings.sizeHint}
                        </p>
                    </div>

                    <div>
                        <label
                            htmlFor="discover-album-exclusion"
                            className="mb-1 block text-sm font-semibold text-content"
                        >
                            {discoverRu.settings.albumExclusion}:{" "}
                            {(config?.exclusionMonths ?? 6) === 0
                                ? discoverRu.settings.disabled
                                : discoverMonthCount(
                                      config?.exclusionMonths ?? 6,
                                  )}
                        </label>
                        <input
                            id="discover-album-exclusion"
                            type="range"
                            min="0"
                            max="12"
                            step="1"
                            value={config?.exclusionMonths ?? 6}
                            onChange={(e) =>
                                handleConfigChange(
                                    "exclusionMonths",
                                    parseInt(e.target.value),
                                )
                            }
                            className="h-11 w-full cursor-pointer appearance-none rounded-lg bg-transparent accent-brand [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-surface-active [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand"
                        />
                        <p className="text-xs leading-5 text-content-muted">
                            {discoverRu.settings.exclusionHint}
                        </p>
                    </div>

                    {/* Clear Playlist */}
                    <div className="border-t border-line pt-5">
                        <p className="mb-2 text-sm font-semibold text-content">
                            {discoverRu.settings.clear}
                        </p>
                        <p className="mb-4 text-xs leading-5 text-content-muted">
                            {discoverRu.settings.clearHint}
                        </p>
                        <Button
                            variant="danger"
                            onClick={() => {
                                if (!isClearing) setShowClearConfirm(true);
                            }}
                            disabled={isClearing}
                        >
                            {isClearing ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Trash2 className="w-4 h-4" />
                            )}
                            {isClearing
                                ? discoverRu.settings.clearing
                                : discoverRu.settings.remove}
                        </Button>
                    </div>
                </div>
            </Card>
            <ConfirmDialog
                isOpen={showClearConfirm}
                onClose={() => setShowClearConfirm(false)}
                onConfirm={confirmClearPlaylist}
                title={discoverRu.settings.confirmTitle}
                message={discoverRu.settings.confirmMessage}
                confirmText={discoverRu.settings.confirm}
                cancelText={discoverRu.settings.cancel}
                variant="danger"
            />
        </div>
    );
}
