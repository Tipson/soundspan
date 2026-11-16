import {
    finiteQueueAdmissionRequestSchema,
    type FiniteQueueAdmissionReference,
    type FiniteQueueAdmissionResponse,
} from "./finiteQueueAdmissionContract";
import { prisma } from "../../utils/db";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import { loadSuppressedYouTubeArtists } from "../personalizedTrackPreferences";
import { providerTrackIdentityToCandidate } from "./canonicalIdentity";
import {
    loadCurrentDislikeAdmission,
    isCurrentDislikeAdmissionAllowed,
} from "./featureStore";
import {
    loadDislikedNativeRecordingIds,
    loadSuppressedNativeArtistCredits,
    loadVerifiedNativeCandidates,
    nativeArtistCreditKey,
} from "./nativeSourceAdmission";
import type { RecommendationCandidate } from "./types";

export type {
    FiniteQueueAdmissionReference,
    FiniteQueueAdmissionResponse,
} from "./finiteQueueAdmissionContract";

type ReadResult<T> = { ok: true; value: T } | { ok: false };
const identityKey = (ref: FiniteQueueAdmissionReference) =>
    `${ref.source}:${ref.id}`;
const exposureKey = (generationId: string, id: string) =>
    JSON.stringify([generationId, id]);
const native = (ref: FiniteQueueAdmissionReference) =>
    ref.source === "vk" || ref.source === "yandex";

// Preserve the existing YT suppression namespace; exposure normalization must not widen it.
function artistKey(value: string): string | null {
    const key = value.trim().toLocaleLowerCase("en-US");
    return key && key !== "unknown" && key !== "unknown artist" ? key : null;
}

function exactReferences(ref: FiniteQueueAdmissionReference): string[] {
    if (ref.source === "library") return [ref.id];
    if (ref.source === "youtube")
        return [ref.id, `yt:${ref.id}`, `youtube:${ref.id}`];
    return [identityKey(ref)];
}

function identityCandidate(
    ref: FiniteQueueAdmissionReference,
): RecommendationCandidate {
    if (ref.source !== "vk" && ref.source !== "yandex")
        return providerTrackIdentityToCandidate({
            source: ref.source,
            providerTrackId: ref.id,
            title: "",
            artist: "",
        });
    // Missing native metadata never acquires a verified credit or canonical edge.
    return {
        id: identityKey(ref),
        canonicalKey: "",
        title: "",
        duration: 0,
        artist: { id: null, name: "" },
        album: { id: null, title: "", coverArt: null },
        source: ref.source,
        streamSource: ref.source,
        provider: {
            source: ref.source,
            providerTrackId: ref.id,
            youtubeVideoId: null,
            tidalTrackId: null,
        },
        candidateSources: ["finite-queue-identity"],
        providerPrior: 1,
    };
}

/** Readmit only the supplied finite queue occurrences against the owner's current policy. */
export async function readmitRecommendationQueue(
    userId: string,
    references: readonly FiniteQueueAdmissionReference[],
    check?: () => void,
): Promise<FiniteQueueAdmissionResponse> {
    let interrupted = false;
    let interruption: unknown;
    const checked = () => {
        if (interrupted) throw interruption;
        try {
            check?.();
        } catch (error) {
            interrupted = true;
            interruption = error;
            throw error;
        }
    };
    const read = async <T>(
        operation: () => Promise<T>,
    ): Promise<ReadResult<T>> => {
        checked();
        let value: T;
        try {
            value = await operation();
        } catch (error) {
            checked();
            if (
                error instanceof Error &&
                (error.name === "AbortError" ||
                    ("code" in error &&
                        (error.code === "RADIO_REQUEST_TIMEOUT" ||
                            error.code === "RADIO_REQUEST_CANCELLED")))
            )
                throw error;
            return { ok: false };
        }
        checked();
        return { ok: true, value };
    };
    checked();
    const parsed = finiteQueueAdmissionRequestSchema.parse({ references });
    const refs = [
        ...new Map(
            parsed.references.map((ref) => [identityKey(ref), ref]),
        ).values(),
    ];
    const localIds = refs
        .filter((r) => r.source === "library")
        .map((r) => r.id);
    const videoIds = refs
        .filter((r) => r.source === "youtube")
        .map((r) => r.id);
    const nativeIds = refs.filter(native).map(identityKey);
    const policyTime = new Date();
    const exactIds = [
        ...new Set(refs.filter((r) => !native(r)).flatMap(exactReferences)),
    ];
    const [exact, nativeExact, localRows, youtubeRows, nativeRows] =
        await Promise.all([
            read(async () =>
                exactIds.length
                    ? prisma.dislikedEntity.findMany({
                          where: {
                              userId,
                              entityType: "track",
                              entityId: { in: exactIds },
                          },
                          take: exactIds.length,
                          select: { entityId: true },
                      })
                    : [],
            ),
            read(() =>
                nativeIds.length
                    ? loadDislikedNativeRecordingIds(
                          userId,
                          nativeIds,
                          policyTime,
                          checked,
                      )
                    : Promise.resolve(new Set<string>()),
            ),
            read(async () =>
                localIds.length
                    ? prisma.track.findMany({
                          where: {
                              ...TRACK_VISIBLE_WHERE,
                              ...TRACK_BROWSE_WHERE,
                              id: { in: localIds },
                          },
                          take: localIds.length,
                          select: {
                              id: true,
                              title: true,
                              duration: true,
                              origin: true,
                              filePath: true,
                              album: {
                                  select: {
                                      artist: { select: { name: true } },
                                  },
                              },
                          },
                      })
                    : [],
            ),
            read(async () =>
                videoIds.length
                    ? prisma.trackYtMusic.findMany({
                          where: { videoId: { in: videoIds } },
                          take: videoIds.length,
                          select: {
                              videoId: true,
                              artist: true,
                              title: true,
                              duration: true,
                          },
                      })
                    : [],
            ),
            read(() =>
                nativeIds.length
                    ? loadVerifiedNativeCandidates(nativeIds, checked)
                    : Promise.resolve([]),
            ),
        ]);
    checked();
    const candidates = new Map(
        refs.map((ref) => [identityKey(ref), identityCandidate(ref)]),
    );
    const artists = new Map<string, string | null>();
    if (localRows.ok)
        for (const row of localRows.value) {
            if (
                !localIds.includes(row.id) ||
                !(
                    row.origin === "FEDERATED" ||
                    (row.origin === "LOCAL" && row.filePath?.trim())
                )
            )
                continue;
            const key = `library:${row.id}`;
            artists.set(key, artistKey(row.album.artist.name));
            candidates.set(
                key,
                providerTrackIdentityToCandidate({
                    source: "library",
                    providerTrackId: row.id,
                    title: row.title,
                    artist: row.album.artist.name,
                    duration: row.duration,
                }),
            );
        }
    const knownArtistVideos = new Set<string>();
    if (youtubeRows.ok)
        for (const row of youtubeRows.value) {
            if (!videoIds.includes(row.videoId)) continue;
            const artist = artistKey(row.artist);
            if (artist) knownArtistVideos.add(row.videoId);
            const key = `youtube:${row.videoId}`;
            artists.set(key, artist);
            candidates.set(
                key,
                providerTrackIdentityToCandidate({
                    source: "youtube",
                    providerTrackId: row.videoId,
                    title: row.title,
                    artist: row.artist,
                    duration: row.duration,
                }),
            );
        }
    if (nativeRows.ok)
        for (const candidate of nativeRows.value) {
            if (nativeIds.includes(candidate.id))
                candidates.set(candidate.id, candidate);
        }
    const cold = [
        ...new Map(
            parsed.references
                .filter(
                    (ref) =>
                        ref.source === "youtube" &&
                        ref.generationId &&
                        !knownArtistVideos.has(ref.id),
                )
                .map((ref) => [
                    exposureKey(ref.generationId!, ref.id),
                    {
                        generationId: ref.generationId!,
                        providerTrackId: ref.id,
                    },
                ]),
        ).values(),
    ];
    const [exposureRows, snapshot, suppressedYoutube, suppressedNative] =
        await Promise.all([
            read(async () =>
                cold.length
                    ? prisma.recommendationExposure.findMany({
                          where: {
                              userId,
                              provider: "youtube",
                              generation: { served: true, userId },
                              OR: cold,
                          },
                          take: cold.length,
                          select: {
                              generationId: true,
                              providerTrackId: true,
                              artistKey: true,
                          },
                      })
                    : [],
            ),
            read(() =>
                loadCurrentDislikeAdmission(
                    userId,
                    [...candidates.values()],
                    checked,
                ),
            ),
            read(() =>
                localIds.length || videoIds.length
                    ? loadSuppressedYouTubeArtists(userId, policyTime)
                    : Promise.resolve(new Set<string>()),
            ),
            read(() =>
                nativeIds.length
                    ? loadSuppressedNativeArtistCredits(
                          userId,
                          policyTime,
                          checked,
                      )
                    : Promise.resolve(new Set<string>()),
            ),
        ]);
    checked();
    const exposedArtists = new Map<string, string | null>();
    const requestedCold = new Set(
        cold.map((ref) => exposureKey(ref.generationId, ref.providerTrackId)),
    );
    if (exposureRows.ok)
        for (const row of exposureRows.value) {
            const key = exposureKey(row.generationId, row.providerTrackId);
            if (requestedCold.has(key))
                exposedArtists.set(key, artistKey(row.artistKey));
        }
    const knownExact = new Set<string>([
        ...(exact.ok ? exact.value.map((row) => row.entityId) : []),
        ...(nativeExact.ok ? nativeExact.value : []),
    ]);
    return {
        version: 1,
        appliesTo: "recommended_future",
        decisions: parsed.references.map((ref) => {
            const key = identityKey(ref),
                candidate = candidates.get(key)!;
            const refs = exactReferences(ref);
            let denied = refs.some(
                (id) =>
                    knownExact.has(id) ||
                    (snapshot.ok && snapshot.value.dislikedKeys.has(id)),
            );
            let unavailable =
                !snapshot.ok ||
                (ref.source === "library" && !localRows.ok) ||
                (ref.source === "youtube" && !youtubeRows.ok) ||
                (native(ref) && !nativeRows.ok);
            if (
                snapshot.ok &&
                !isCurrentDislikeAdmissionAllowed(candidate, snapshot.value)
            ) {
                const verified = snapshot.value.verifiedCanonicalKeys.get(
                    `${candidate.source}:${candidate.id}`,
                );
                if (verified && snapshot.value.dislikedKeys.has(verified))
                    denied = true;
                else if (
                    snapshot.value.unavailableCandidateReferences?.has(
                        `${candidate.source}:${candidate.id}`,
                    ) ||
                    (verified &&
                        snapshot.value.unavailableCanonicalKeys.has(verified))
                )
                    unavailable = true;
                else denied = true;
            }
            if (native(ref)) {
                const credit = nativeArtistCreditKey(
                    candidate.musicSourceRecording,
                );
                if (credit) {
                    if (!suppressedNative.ok) unavailable = true;
                    else if (suppressedNative.value.has(credit)) denied = true;
                }
            } else if (ref.source === "library" || ref.source === "youtube") {
                let artist = artists.get(key);
                if (
                    ref.source === "youtube" &&
                    !knownArtistVideos.has(ref.id) &&
                    ref.generationId
                ) {
                    if (!exposureRows.ok) unavailable = true;
                    else
                        artist = exposedArtists.get(
                            exposureKey(ref.generationId, ref.id),
                        );
                }
                if (artist) {
                    if (!suppressedYoutube.ok) unavailable = true;
                    else if (suppressedYoutube.value.has(artist)) denied = true;
                }
            }
            return {
                source: ref.source,
                id: ref.id,
                state: denied
                    ? "denied"
                    : unavailable
                      ? "unavailable"
                      : "allowed",
            };
        }),
    };
}
