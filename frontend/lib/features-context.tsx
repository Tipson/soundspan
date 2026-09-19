"use client";

import {
    createContext,
    useContext,
    useEffect,
    useState,
    useMemo,
    ReactNode,
    useCallback,
    useRef,
} from "react";
import { api } from "./api";
import { useAuth } from "./auth-context";
import { useVisibilityGatedInterval } from "../hooks/useVisibilityGatedInterval";
import { frontendLogger as sharedFrontendLogger } from "./logger";
import type { VibeSystemStatus } from "./api/settings";

interface FeaturesState {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
    audioAnalysis: boolean;
    discovery: boolean;
    autoPlaylists: boolean;
    federation: boolean;
    audius: boolean;
    vibe: VibeSystemStatus;
    /** Server-configured loudness normalization reference (LUFS). */
    loudnessTargetLufs: number;
    showVersion: boolean;
    loading: boolean;
}

// Configured feature flags (audioAnalysis/discovery/autoPlaylists) default ON
// server-side, so they default true here to avoid hiding sections while the
// first features fetch is in flight.
const defaultState: FeaturesState = {
    musicCNN: false,
    vibeEmbeddings: false,
    audioAnalysis: true,
    discovery: true,
    autoPlaylists: true,
    federation: false,
    audius: false,
    vibe: {
        provider: {
            configured: false,
            reachable: null,
            checkedAt: null,
            fresh: false,
        },
        activeSpace: null,
        migration: null,
    },
    loudnessTargetLufs: -18,
    showVersion: false,
    loading: true,
};
const FEATURES_REFRESH_INTERVAL_MS = 60_000;

const FeaturesContext = createContext<FeaturesState | undefined>(undefined);

/**
 * Renders the FeaturesProvider component.
 */
export function FeaturesProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated, isLoading, user } = useAuth();
    const userId = user?.id;
    const canFetch = isAuthenticated && !isLoading && Boolean(userId);
    const [state, setState] = useState<FeaturesState & { accountId?: string }>(
        defaultState,
    );
    const isMountedRef = useRef(false);
    const requestEpochRef = useRef(0);
    const refreshFeatures = useCallback(async () => {
        const requestEpoch = ++requestEpochRef.current;
        const isCurrent = () =>
            isMountedRef.current && requestEpoch === requestEpochRef.current;
        try {
            const [features, uiSettings] = await Promise.all([
                api.getFeatures(),
                api.getUiSettings().catch(() => ({ showVersion: false })),
            ]);
            if (!isCurrent()) return;
            setState({
                accountId: userId,
                musicCNN: features.musicCNN,
                vibeEmbeddings: features.vibeEmbeddings,
                audioAnalysis: features.audioAnalysis ?? true,
                discovery: features.discovery ?? true,
                autoPlaylists: features.autoPlaylists ?? true,
                federation: features.federation ?? false,
                audius: features.audius === true,
                vibe: features.vibe,
                loudnessTargetLufs:
                    typeof features.loudnessTargetLufs === "number"
                        ? features.loudnessTargetLufs
                        : -18,
                showVersion: uiSettings.showVersion,
                loading: false,
            });
        } catch (error) {
            if (!isCurrent()) return;
            sharedFrontendLogger.error("Failed to fetch features:", error);
            setState((prev) =>
                prev.loading || prev.accountId !== userId
                    ? {
                          accountId: userId,
                          musicCNN: false,
                          vibeEmbeddings: false,
                          audioAnalysis: true,
                          discovery: true,
                          autoPlaylists: true,
                          federation: false,
                          audius: false,
                          vibe: defaultState.vibe,
                          loudnessTargetLufs: -18,
                          showVersion: false,
                          loading: false,
                      }
                    : prev,
            );
        }
    }, [userId]);

    const safeRefresh = useCallback(async () => {
        if (!isMountedRef.current || !canFetch) return;
        await refreshFeatures();
    }, [canFetch, refreshFeatures]);

    useVisibilityGatedInterval(safeRefresh, FEATURES_REFRESH_INTERVAL_MS, {
        enabled: canFetch,
    });

    useEffect(() => {
        isMountedRef.current = true;
        void safeRefresh();
        return () => {
            isMountedRef.current = false;
            requestEpochRef.current += 1;
        };
    }, [safeRefresh, userId, isLoading, canFetch]);

    const value = useMemo(
        () =>
            canFetch && state.accountId === userId
                ? state
                : { ...defaultState, loading: isLoading || canFetch },
        [state, canFetch, userId, isLoading],
    );

    return (
        <FeaturesContext.Provider value={value}>
            {children}
        </FeaturesContext.Provider>
    );
}

/**
 * Executes useFeatures.
 */
export function useFeatures(): FeaturesState {
    const context = useContext(FeaturesContext);
    if (!context) {
        throw new Error("useFeatures must be used within FeaturesProvider");
    }
    return context;
}
