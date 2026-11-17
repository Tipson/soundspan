"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
    getAuthRuntimeLease,
    isCurrentAuthRuntime,
} from "../auth-runtime-generation";
import { getQueueReplacementGeneration } from "../audio-engine/playbackAdvanceOrigin";
import { getRecommendationSessionId } from "../recommendationSession";
import { isListenTogetherActiveOrPending } from "../listen-together-session";
import { registerAdaptiveWaveFeedbackOwner } from "./adaptiveWaveFeedback";

const MAX_PENDING_SKIPS = 64;
const EPISODE_LIFETIME_MS = 60_000;

interface RetuneInput {
    enabled: boolean;
    station: string;
    regenerate(token: object): Promise<unknown>;
}

interface Episode {
    scope: string;
    token: object;
    baseRevision: number;
    requests: number;
    running: boolean;
    queuedThreshold: boolean;
    timer: ReturnType<typeof setTimeout>;
}

/** Coalesce acknowledged final skips into at most one trailing retune, without gating playback. */
export function useAdaptiveWaveRetune(input: RetuneInput): () => void {
    const latest = useRef(input);
    useLayoutEffect(() => {
        latest.current = input;
    });
    const [lease] = useState(getAuthRuntimeLease);
    const [apiGeneration] = useState(() => api.getSessionGeneration());
    const collaborative = isListenTogetherActiveOrPending();
    const mounted = useRef(false);
    const revision = useRef(0);
    const episode = useRef<Episode | null>(null);
    const pending = useRef(
        new Map<
            object,
            { scope: string; timer: ReturnType<typeof setTimeout> }
        >(),
    );
    const run = useRef<(value: Episode) => void>(() => {});
    const maybeTrail = useRef<() => void>(() => {});
    const scope = useCallback(() => {
        if (
            !mounted.current ||
            lease.signal.aborted ||
            !isCurrentAuthRuntime(lease.generation) ||
            api.getSessionGeneration() !== apiGeneration ||
            !latest.current.enabled ||
            isListenTogetherActiveOrPending()
        )
            return null;
        return JSON.stringify([
            getQueueReplacementGeneration(),
            getRecommendationSessionId(),
            latest.current.station,
        ]);
    }, [lease, apiGeneration]);
    const retire = useCallback(() => {
        if (episode.current) clearTimeout(episode.current.timer);
        episode.current = null;
    }, []);
    const requestRetune = useCallback(() => {
        const captured = scope();
        if (captured === null) return;
        const active = episode.current;
        if (active?.scope === captured) {
            // The first trailing read covers its pending burst. A new threshold
            // after that read starts owns one following episode, rather than disappearing.
            if (active.requests === 2) active.queuedThreshold = true;
            return;
        }
        retire();
        const value: Episode = {
            scope: captured,
            token: {},
            baseRevision: revision.current,
            requests: 0,
            running: false,
            queuedThreshold: false,
            timer: setTimeout(retire, EPISODE_LIFETIME_MS),
        };
        episode.current = value;
        run.current(value);
    }, [scope, retire]);
    useLayoutEffect(() => {
        maybeTrail.current = () => {
            const value = episode.current;
            if (
                !value ||
                value.running ||
                value.requests !== 1 ||
                value.scope !== scope()
            )
                return;
            if (
                revision.current <= value.baseRevision ||
                [...pending.current.values()].some(
                    (row) => row.scope === value.scope,
                )
            )
                return;
            run.current(value);
        };
        run.current = (value) => {
            if (
                episode.current !== value ||
                value.scope !== scope() ||
                value.requests >= 2
            )
                return;
            value.requests++;
            value.running = true;
            // The existing queue owner checks every async response again before committing its tail.
            void Promise.resolve()
                .then(() => {
                    if (episode.current !== value || value.scope !== scope())
                        return;
                    return latest.current.regenerate(value.token);
                })
                .catch(() => undefined)
                .finally(() => {
                    if (episode.current !== value) return;
                    value.running = false;
                    if (value.requests >= 2 || value.scope !== scope()) {
                        const again =
                            value.queuedThreshold && value.scope === scope();
                        retire();
                        if (again)
                            queueMicrotask(() => {
                                // Never transfer a queued threshold to a replacement station.
                                if (scope() === value.scope && !episode.current)
                                    requestRetune();
                            });
                    } else queueMicrotask(() => maybeTrail.current());
                });
        };
    });
    useLayoutEffect(() => {
        mounted.current = true;
        const ownedPending = pending.current;
        const unregister = registerAdaptiveWaveFeedbackOwner({
            capture: () => {
                const captured = scope();
                if (captured === null) return null;
                return () => {
                    if (
                        scope() !== captured ||
                        ownedPending.size >= MAX_PENDING_SKIPS
                    )
                        return null;
                    const token = {};
                    const settle = (committed: boolean) => {
                        const row = ownedPending.get(token);
                        if (!row) return;
                        clearTimeout(row.timer);
                        ownedPending.delete(token);
                        if (committed && scope() === captured)
                            revision.current++;
                        queueMicrotask(() => maybeTrail.current());
                    };
                    ownedPending.set(token, {
                        scope: captured,
                        timer: setTimeout(
                            () => settle(false),
                            EPISODE_LIFETIME_MS,
                        ),
                    });
                    return {
                        commit: () => settle(true),
                        abandon: () => settle(false),
                    };
                };
            },
        });
        return () => {
            mounted.current = false;
            unregister();
            retire();
            for (const row of ownedPending.values()) clearTimeout(row.timer);
            ownedPending.clear();
        };
    }, [scope, retire, input.station, input.enabled, collaborative]);
    useLayoutEffect(() => {
        if (episode.current && episode.current.scope !== scope()) retire();
    });
    return requestRetune;
}
