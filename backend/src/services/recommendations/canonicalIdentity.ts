import { prisma } from "../../utils/db";
import type { RecommendationCandidate } from "./types";

export interface ResolvedCanonicalRecording {
    id: string;
    canonicalKey: string;
}

interface CanonicalIdentityDependencies {
    findProviderMapping: (
        provider: RecommendationCandidate["source"],
        providerTrackId: string,
    ) => Promise<ResolvedCanonicalRecording | null>;
    findCanonical: (
        candidate: RecommendationCandidate,
        canonicalKey: string,
    ) => Promise<ResolvedCanonicalRecording | null>;
    upsertCanonical: (
        candidate: RecommendationCandidate,
        canonicalKey: string,
    ) => Promise<ResolvedCanonicalRecording>;
    attachProviderMapping: (
        candidate: RecommendationCandidate,
        canonicalRecordingId: string,
    ) => Promise<void>;
}

function normalizedText(value: string): string {
    return value
        .normalize("NFKC")
        .replace(/[‘’`′ʼ]/g, "'")
        .replace(
            /\s*\([^)]*(remaster|version|edition|mix|live)[^)]*\)\s*/giu,
            " ",
        )
        .replace(
            /\s*\[[^\]]*(remaster|version|edition|mix|live)[^\]]*\]\s*/giu,
            " ",
        )
        .replace(
            /\s*-\s*(\d{4}\s+)?(remaster(ed)?|deluxe|bonus|single|radio edit|remix|acoustic|live|version|edition|mix).*$/iu,
            "",
        )
        .toLocaleLowerCase("en-US")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

/** Durable-identity ladder shared by provider dedupe and analysis reuse. */
export function buildCanonicalRecordingKey(
    candidate: Pick<
        RecommendationCandidate,
        | "recordingMbid"
        | "isrc"
        | "fingerprint"
        | "artist"
        | "title"
        | "duration"
    >,
): string {
    const mbid = candidate.recordingMbid?.trim().toLocaleLowerCase("en-US");
    if (mbid) return `mbid:${mbid}`;
    const isrc = candidate.isrc?.replace(/[^a-z0-9]/giu, "").toUpperCase();
    if (isrc) return `isrc:${isrc}`;
    const fingerprint = candidate.fingerprint?.trim().toLocaleLowerCase();
    if (fingerprint) return `fingerprint:${fingerprint}`;
    const durationBucket = Math.max(0, Math.round(candidate.duration / 3) * 3);
    return `meta:${normalizedText(candidate.artist.name)}:${normalizedText(
        candidate.title,
    )}:${durationBucket}`;
}

function providerTrackId(candidate: RecommendationCandidate): string | null {
    if (candidate.source === "youtube") {
        return (
            candidate.provider.youtubeVideoId ??
            candidate.youtubeVideoId ??
            null
        );
    }
    if (candidate.source === "tidal") {
        return (
            candidate.provider.tidalTrackId?.toString() ??
            candidate.tidalTrackId?.toString() ??
            null
        );
    }
    return candidate.id || null;
}

export class CanonicalIdentityResolver {
    constructor(private readonly dependencies: CanonicalIdentityDependencies) {}

    async resolve(
        candidate: RecommendationCandidate,
    ): Promise<ResolvedCanonicalRecording> {
        const providerId = providerTrackId(candidate);
        if (providerId) {
            const mapped = await this.dependencies.findProviderMapping(
                candidate.source,
                providerId,
            );
            if (mapped) return mapped;
        }
        const canonicalKey = buildCanonicalRecordingKey(candidate);
        let canonical = await this.dependencies.findCanonical(
            candidate,
            canonicalKey,
        );
        if (!canonical) {
            try {
                canonical = await this.dependencies.upsertCanonical(
                    candidate,
                    canonicalKey,
                );
            } catch (error) {
                canonical = await this.dependencies.findCanonical(
                    candidate,
                    canonicalKey,
                );
                if (!canonical) throw error;
            }
        }
        if (providerId) {
            await this.dependencies.attachProviderMapping(
                candidate,
                canonical.id,
            );
        }
        return canonical;
    }
}

async function findProviderMapping(
    provider: RecommendationCandidate["source"],
    id: string,
): Promise<ResolvedCanonicalRecording | null> {
    const providerWhere =
        provider === "youtube"
            ? { trackYtMusic: { is: { videoId: id } } }
            : provider === "tidal"
              ? { trackTidal: { is: { tidalId: Number(id) } } }
              : { track: { is: { id } } };
    const mapping = await prisma.trackMapping.findFirst({
        where: {
            ...providerWhere,
            stale: false,
            canonicalRecordingId: { not: null },
        },
        select: {
            canonicalRecording: { select: { id: true, canonicalKey: true } },
        },
    });
    return mapping?.canonicalRecording ?? null;
}

async function findCanonical(
    candidate: RecommendationCandidate,
    canonicalKey: string,
): Promise<ResolvedCanonicalRecording | null> {
    const durableMatches = [
        candidate.recordingMbid
            ? { recordingMbid: candidate.recordingMbid.trim() }
            : null,
        candidate.isrc
            ? { isrc: candidate.isrc.replace(/[^a-z0-9]/giu, "").toUpperCase() }
            : null,
        candidate.fingerprint
            ? { fingerprint: candidate.fingerprint.trim() }
            : null,
        { canonicalKey },
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return prisma.canonicalRecording.findFirst({
        where: { OR: durableMatches },
        select: { id: true, canonicalKey: true },
    });
}

async function upsertCanonical(
    candidate: RecommendationCandidate,
    canonicalKey: string,
): Promise<ResolvedCanonicalRecording> {
    return prisma.canonicalRecording.upsert({
        where: { canonicalKey },
        create: {
            canonicalKey,
            recordingMbid: candidate.recordingMbid?.trim() || null,
            isrc:
                candidate.isrc?.replace(/[^a-z0-9]/giu, "").toUpperCase() ||
                null,
            fingerprint: candidate.fingerprint?.trim() || null,
            title: candidate.title.trim(),
            artist: candidate.artist.name.trim(),
            duration: Math.max(0, Math.round(candidate.duration)),
        },
        update: {
            recordingMbid: candidate.recordingMbid?.trim() || undefined,
            isrc:
                candidate.isrc?.replace(/[^a-z0-9]/giu, "").toUpperCase() ||
                undefined,
            fingerprint: candidate.fingerprint?.trim() || undefined,
        },
        select: { id: true, canonicalKey: true },
    });
}

async function attachProviderMapping(
    candidate: RecommendationCandidate,
    canonicalRecordingId: string,
): Promise<void> {
    if (candidate.source === "youtube") {
        const videoId = providerTrackId(candidate);
        if (!videoId) return;
        const providerTrack = await prisma.trackYtMusic.upsert({
            where: { videoId },
            create: {
                videoId,
                title: candidate.title,
                artist: candidate.artist.name,
                album: candidate.album.title,
                duration: Math.max(0, Math.round(candidate.duration)),
                thumbnailUrl: candidate.album.coverArt,
            },
            update: {
                title: candidate.title,
                artist: candidate.artist.name,
                album: candidate.album.title,
                duration: Math.max(0, Math.round(candidate.duration)),
                thumbnailUrl: candidate.album.coverArt,
            },
            select: { id: true },
        });
        const mapping = await prisma.trackMapping.findFirst({
            where: { trackYtMusicId: providerTrack.id, stale: false },
            select: { id: true },
        });
        if (mapping) {
            await prisma.trackMapping.update({
                where: { id: mapping.id },
                data: { canonicalRecordingId },
            });
        } else {
            await prisma.trackMapping.create({
                data: {
                    trackYtMusicId: providerTrack.id,
                    canonicalRecordingId,
                    confidence: 0.72,
                    source: "recommendation",
                },
            });
        }
        return;
    }
    if (candidate.source === "tidal") {
        const rawId = providerTrackId(candidate);
        const tidalId = rawId ? Number(rawId) : Number.NaN;
        if (!Number.isSafeInteger(tidalId)) return;
        const providerTrack = await prisma.trackTidal.upsert({
            where: { tidalId },
            create: {
                tidalId,
                title: candidate.title,
                artist: candidate.artist.name,
                album: candidate.album.title,
                duration: Math.max(0, Math.round(candidate.duration)),
                isrc: candidate.isrc || null,
            },
            update: {
                title: candidate.title,
                artist: candidate.artist.name,
                album: candidate.album.title,
                duration: Math.max(0, Math.round(candidate.duration)),
                isrc: candidate.isrc || undefined,
            },
            select: { id: true },
        });
        const mapping = await prisma.trackMapping.findFirst({
            where: { trackTidalId: providerTrack.id, stale: false },
            select: { id: true },
        });
        if (mapping) {
            await prisma.trackMapping.update({
                where: { id: mapping.id },
                data: { canonicalRecordingId },
            });
        } else {
            await prisma.trackMapping.create({
                data: {
                    trackTidalId: providerTrack.id,
                    canonicalRecordingId,
                    confidence: candidate.isrc ? 0.95 : 0.72,
                    source: "recommendation",
                },
            });
        }
    }
}

export const canonicalIdentityResolver = new CanonicalIdentityResolver({
    findProviderMapping,
    findCanonical,
    upsertCanonical,
    attachProviderMapping,
});
