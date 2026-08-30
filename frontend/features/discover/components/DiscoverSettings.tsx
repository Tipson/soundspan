"use client";

import { useState, useRef } from "react";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
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
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-6">
            <Card className="p-6">
                <h2 className="text-xl font-bold mb-4">
                    {discoverRu.settings.title}
                </h2>
                <div className="space-y-6">
                    <div>
                        <label className="block text-sm font-medium mb-2">
                            {discoverRu.settings.playlistSize}:{" "}
                            {discoverTrackCount(config?.playlistSize || 10)}
                        </label>
                        <input
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
                            className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ai"
                        />
                        <p className="text-xs text-gray-400 mt-2">
                            {discoverRu.settings.sizeHint}
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-2">
                            {discoverRu.settings.albumExclusion}:{" "}
                            {(config?.exclusionMonths ?? 6) === 0
                                ? discoverRu.settings.disabled
                                : discoverMonthCount(
                                      config?.exclusionMonths ?? 6,
                                  )}
                        </label>
                        <input
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
                            className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ai"
                        />
                        <p className="text-xs text-gray-400 mt-2">
                            {discoverRu.settings.exclusionHint}
                        </p>
                    </div>

                    {/* Clear Playlist */}
                    <div className="pt-4 border-t border-white/10">
                        <label className="block text-sm font-medium mb-2">
                            {discoverRu.settings.clear}
                        </label>
                        <p className="text-xs text-gray-400 mb-3">
                            {discoverRu.settings.clearHint}
                        </p>
                        <button
                            onClick={() => {
                                if (!isClearing) setShowClearConfirm(true);
                            }}
                            disabled={isClearing}
                            className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isClearing ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Trash2 className="w-4 h-4" />
                            )}
                            {isClearing
                                ? discoverRu.settings.clearing
                                : discoverRu.settings.remove}
                        </button>
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
