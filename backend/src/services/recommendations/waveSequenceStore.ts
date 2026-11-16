import type { validateWaveSequenceContinuation } from "./waveSequence";
import { prisma } from "../../utils/db";

/** Read one authenticated served Wave page; no candidate or artist-name lookups. */
export async function loadWaveSequenceGeneration(
    generationId: string,
    userId: string,
    sessionId: string,
): Promise<
    Parameters<typeof validateWaveSequenceContinuation>[0]["generation"] | null
> {
    return prisma.recommendationGeneration.findFirst({
        where: {
            id: generationId,
            userId,
            sessionId,
            surface: "wave",
            served: true,
        },
        select: {
            id: true,
            userId: true,
            sessionId: true,
            surface: true,
            served: true,
            createdAt: true,
            context: true,
        },
    });
}
