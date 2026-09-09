import { prisma } from "../../utils/db";
import type { RecommendationCandidate } from "./types";

/** Exclude saved originals across provider uploads, using only this account's likes. */
export async function loadSavedCanonicalKeys(
    userId: string,
    candidates: readonly RecommendationCandidate[],
): Promise<ReadonlySet<string>> {
    const ids = [
        ...new Set(
            candidates.flatMap((candidate) =>
                candidate.canonicalRecordingId
                    ? [candidate.canonicalRecordingId]
                    : [],
            ),
        ),
    ];
    const keys = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 250) {
        const chunk = ids.slice(offset, offset + 250);
        const rows = await prisma.canonicalRecording.findMany({
            where: {
                id: { in: chunk },
                mappings: {
                    some: {
                        stale: false,
                        trackYtMusic: { is: { likedBy: { some: { userId } } } },
                    },
                },
            },
            select: { canonicalKey: true },
            take: chunk.length,
        });
        for (const row of rows) keys.add(row.canonicalKey);
    }
    return keys;
}
