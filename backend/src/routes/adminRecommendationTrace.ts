import type { Request, Response } from "express";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../utils/routeErrorResponse";
import {
    GENERATION_TRACE_LIMITS,
    readRecommendationGenerationTrace,
    type RecommendationGenerationTraceV1,
} from "../services/recommendations/generationTrace";
import type {
    RecommendationCandidate,
    RecommendationSurface,
} from "../services/recommendations/types";

const log = logger.child("AdminRecommendationTrace");
const exactId = /^[A-Za-z0-9_-]{1,128}$/;
const sources: readonly RecommendationCandidate["source"][] = [
    "youtube",
    "tidal",
    "library",
    "vk",
    "yandex",
];
const surfaces: readonly RecommendationSurface[] = [
    "wave",
    "home",
    "made-for-you",
    "similar-tracks",
];
const referencePatterns: Record<RecommendationCandidate["source"], RegExp> = {
    youtube: /^[A-Za-z0-9_-]{1,64}$/,
    library: /^[A-Za-z0-9_-]{1,128}$/,
    tidal: /^\d{1,16}$/,
    vk: /^(?:vk:)?-?\d{1,20}_\d{1,20}$/,
    yandex: /^(?:yandex:)?\d{1,20}(?::\d{1,20})?$/,
};

/** A stored exposure reference; source is the provider enum, never raw provenance. */
export interface AdminRecommendationTraceExposure {
    position: number;
    source: RecommendationCandidate["source"] | null;
    providerTrackId: string | null;
    score: number | null;
}

/** Private single-generation response; legacy or malformed diagnostics stay unavailable. */
export type AdminRecommendationTraceResponse =
    | { available: false; generationId: string }
    | {
          available: true;
          generationId: string;
          createdAt: string;
          surface: RecommendationSurface;
          algorithm: RecommendationGenerationTraceV1["algorithm"];
          served: boolean;
          trace: RecommendationGenerationTraceV1;
          exposures: AdminRecommendationTraceExposure[];
      };

function reference(
    source: AdminRecommendationTraceExposure["source"],
    value: unknown,
): string | null {
    return source !== null &&
        typeof value === "string" &&
        value.length <= 128 &&
        referencePatterns[source].test(value)
        ? value
        : null;
}

/** Read one exact owner-scoped generation after the registered interactive-admin guards. */
export async function handleAdminRecommendationTrace(
    req: Request,
    res: Response,
): Promise<Response> {
    res.setHeader("Cache-Control", "private, no-store");
    res.vary("Authorization");
    const query = req.query;
    const userId = query.userId;
    const generationId = query.generationId;
    if (
        Object.keys(query).length !== 2 ||
        Object.keys(query).some(
            (key) => key !== "userId" && key !== "generationId",
        ) ||
        typeof userId !== "string" ||
        typeof generationId !== "string" ||
        !exactId.test(userId) ||
        !exactId.test(generationId)
    ) {
        return sendRouteError(res, 400, "Invalid recommendation trace query");
    }
    try {
        const generation = await prisma.recommendationGeneration.findFirst({
            where: { id: generationId, userId },
            select: {
                id: true,
                userId: true,
                createdAt: true,
                surface: true,
                algorithm: true,
                served: true,
                context: true,
                exposures: {
                    where: { generationId, userId },
                    orderBy: [{ position: "asc" }, { id: "asc" }],
                    take: GENERATION_TRACE_LIMITS.rows,
                    select: {
                        userId: true,
                        generationId: true,
                        position: true,
                        provider: true,
                        providerTrackId: true,
                        score: true,
                    },
                },
            },
        });
        if (
            !generation ||
            generation.id !== generationId ||
            generation.userId !== userId
        ) {
            return sendRouteError(
                res,
                404,
                "Recommendation generation not found",
            );
        }
        const context = generation.context;
        const trace = readRecommendationGenerationTrace(
            context && typeof context === "object" && !Array.isArray(context)
                ? context.recommendationTrace
                : undefined,
        );
        if (
            !trace ||
            trace.algorithm !== generation.algorithm ||
            trace.served !== generation.served ||
            !surfaces.includes(generation.surface as RecommendationSurface) ||
            !(generation.createdAt instanceof Date) ||
            !Number.isFinite(generation.createdAt.getTime())
        ) {
            const unavailable: AdminRecommendationTraceResponse = {
                available: false,
                generationId,
            };
            return res.json(unavailable);
        }
        const exposures = generation.exposures
            .slice(0, GENERATION_TRACE_LIMITS.rows)
            .filter(
                (exposure) =>
                    exposure.userId === userId &&
                    exposure.generationId === generationId &&
                    Number.isInteger(exposure.position) &&
                    exposure.position >= 0 &&
                    exposure.position <= 2_147_483_647,
            )
            .sort((left, right) => left.position - right.position)
            .map((exposure): AdminRecommendationTraceExposure => {
                // Exposure.source contains unconstrained candidate-source labels.
                const source = sources.includes(
                    exposure.provider as RecommendationCandidate["source"],
                )
                    ? (exposure.provider as RecommendationCandidate["source"])
                    : null;
                return {
                    position: exposure.position,
                    source,
                    providerTrackId: reference(
                        source,
                        exposure.providerTrackId,
                    ),
                    score:
                        typeof exposure.score === "number" &&
                        Number.isFinite(exposure.score)
                            ? exposure.score
                            : null,
                };
            });
        const response: AdminRecommendationTraceResponse = {
            available: true,
            generationId,
            createdAt: generation.createdAt.toISOString(),
            surface: generation.surface as RecommendationSurface,
            algorithm: trace.algorithm,
            served: generation.served,
            trace,
            exposures,
        };
        return res.json(response);
    } catch (error) {
        log.error("Recommendation trace lookup failed", error);
        return sendInternalRouteError(
            res,
            "Failed to read recommendation trace",
        );
    }
}
