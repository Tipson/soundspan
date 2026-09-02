"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "@/lib/api";
import { frontendLogger } from "@/lib/logger";
import type { PersonalizedTrack } from "../types";
import {
    recommendationImpressionIdentity,
    recommendationTrackKey,
} from "../recommendationIdentity";

const log = frontendLogger.child("RecommendationImpressions");

/** Records each recommendation only when its own card enters the viewport. */
export function useRecommendationImpressions(
    generationId: string | undefined,
    tracks: PersonalizedTrack[],
) {
    const nodeRef = useRef<HTMLElement | null>(null);
    const sentRef = useRef(new Set<string>());
    const identitiesByKey = useMemo(
        () =>
            new Map(
                tracks.flatMap((track) => {
                    const identity = recommendationImpressionIdentity(track);
                    return identity
                        ? [[recommendationTrackKey(track), identity] as const]
                        : [];
                }),
            ),
        [tracks],
    );

    const observe = useCallback((node: HTMLElement | null) => {
        nodeRef.current = node;
    }, []);

    useEffect(() => {
        const node = nodeRef.current;
        if (!node || !generationId || identitiesByKey.size === 0) {
            return;
        }
        if (typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            (entries) => {
                const visibleKeys = entries.flatMap((entry) => {
                    if (!entry.isIntersecting) return [];
                    const key = (entry.target as HTMLElement).dataset
                        .recommendationTrackKey;
                    return key ? [key] : [];
                });
                const pendingKeys = Array.from(new Set(visibleKeys)).filter(
                    (key) => !sentRef.current.has(`${generationId}:${key}`),
                );
                const identities = pendingKeys.flatMap((key) => {
                    const identity = identitiesByKey.get(key);
                    return identity ? [identity] : [];
                });
                if (identities.length === 0) return;
                pendingKeys.forEach((key) => {
                    sentRef.current.add(`${generationId}:${key}`);
                });
                void api
                    .reportRecommendationImpressions(generationId, identities)
                    .catch((error: unknown) => {
                        pendingKeys.forEach((key) => {
                            sentRef.current.delete(`${generationId}:${key}`);
                        });
                        log.warn(
                            "Failed to report recommendation impressions",
                            {
                                generationId,
                                error,
                            },
                        );
                    });
            },
            { threshold: 0.2 },
        );
        const targets = [
            ...(node.matches("[data-recommendation-track-key]") ? [node] : []),
            ...node.querySelectorAll<HTMLElement>(
                "[data-recommendation-track-key]",
            ),
        ];
        targets.forEach((target) => observer.observe(target));
        return () => observer.disconnect();
    }, [generationId, identitiesByKey]);

    return observe;
}
