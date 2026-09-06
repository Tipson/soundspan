"use client";

import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { beginWaveStartWarmup } from "@/lib/audio-engine/waveStartWarmup";

/** Prepare only the visible Wave's first source without playing or rating it. */
export function useWaveStartWarmup(videoId: string | null, enabled: boolean) {
    const interest = useRef<ReturnType<typeof beginWaveStartWarmup> | null>(
        null,
    );
    useEffect(() => {
        if (!enabled || !videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId))
            return;
        const connection = (
            navigator as Navigator & {
                connection?: { saveData?: boolean; effectiveType?: string };
            }
        ).connection;
        if (
            connection?.saveData ||
            ["slow-2g", "2g"].includes(connection?.effectiveType ?? "")
        )
            return;
        // A short dwell avoids starting provider work for a transient route.
        let timer: ReturnType<typeof setTimeout> | null = null;
        let resource: ReturnType<typeof beginWaveStartWarmup> | null = null;
        const stop = () => {
            if (timer !== null) clearTimeout(timer);
            timer = null;
            resource?.dispose();
            if (interest.current === resource) interest.current = null;
            resource = null;
        };
        const update = () => {
            if (document.visibilityState === "hidden") {
                stop();
                return;
            }
            if (timer !== null || resource) return;
            timer = setTimeout(() => {
                timer = null;
                resource = beginWaveStartWarmup(
                    (request, signal) =>
                        api.reconcileYtMusicTailWarmup(request, signal),
                    `wave-start:${crypto.randomUUID()}`,
                    videoId,
                );
                interest.current = resource;
            }, 300);
        };
        update();
        document.addEventListener("visibilitychange", update);
        return () => {
            document.removeEventListener("visibilitychange", update);
            stop();
        };
    }, [videoId, enabled]);
    return useCallback(() => interest.current?.handoff(), []);
}
