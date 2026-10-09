import type { PlaybackRadioOrigin } from "@soundspan/media-metadata-contract";
import { buildCanonicalRecordingKey } from "./canonicalIdentity";
import type { RecommendationCandidateBatch } from "./engine";
import { songRepeatKey } from "../personalizedRepeatPolicy";
import type { RecommendationCandidate } from "./types";
import type { RadioRequestExecution } from "./radioRequestExecution";
import {
    hasNativeRecommendationIdentity,
    readNativeRecommendationRecording,
    toNativeRecommendationCandidate,
} from "./nativeCandidates";
import { nativeArtistCreditKey } from "./nativeSourceAdmission";

/** Account-owned continuation of the original station, independently of its current song. */
export interface RadioContinuationInput {
    userId: string;
    sessionId: string;
    radioOrigin: PlaybackRadioOrigin;
    cursor: number;
    limit: number;
    exclude: string[];
    diagnostic?: boolean;
    /** Server-owned execution scope; never accepted from continuation query parameters. */
    execution?: RadioRequestExecution;
    /** Owner cancellation for native source work; not a client-supplied query field. */
    sourceSignal?: AbortSignal;
}

/** Existing actual-listening rules captured once at the engine policy clock. */
export interface RadioContinuationPreferences {
    ids: ReadonlySet<string>;
    songKeys: ReadonlySet<string>;
    suppressedArtists: ReadonlySet<string>;
    suppressedNativeCredits?: ReadonlySet<string>;
    degradedSources: string[];
}

/** Seed selection and pre-quota admission remain outside the ranking/exposure engine. */
export interface RadioContinuationLoaderDependencies {
    loadSeedTracks: (
        input: RadioContinuationInput,
        admitTrackIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>,
    ) => Promise<{ tracks: unknown[]; degradedSources: string[] }>;
    loadPreferences: (
        userId: string,
        policyTime: Date,
        execution?: RadioRequestExecution,
        nativeSource?: "vk" | "yandex",
    ) => Promise<RadioContinuationPreferences>;
    loadLibraryTracks: (ids: readonly string[]) => Promise<unknown[]>;
    admitCandidates: (
        userId: string,
        candidates: RecommendationCandidate[],
        policyTime: Date,
        exclude: readonly string[],
        /** Actual listening identities captured once before seed/local-selection quotas. */
        repeatIds?: ReadonlySet<string>,
        execution?: RadioRequestExecution,
    ) => Promise<{
        candidates: RecommendationCandidate[];
        degradedSources: string[];
    }>;
}

/** Public mixed-source track shape, with no feature-store or filesystem internals. */
export type RadioContinuationTrack = Pick<
    RecommendationCandidate,
    | "id"
    | "title"
    | "duration"
    | "trackNo"
    | "artist"
    | "album"
    | "source"
    | "provider"
> & {
    youtubeVideoId?: string;
    streamSource?: "youtube" | "vk" | "yandex";
    musicSourceRecording?: RecommendationCandidate["musicSourceRecording"];
};

/** Ordered membership exactly matching the served generation. */
export interface RadioContinuationResponse {
    tracks: RadioContinuationTrack[];
    radioOrigin: PlaybackRadioOrigin;
    generationId: string;
    nextCursor: number;
    degraded: boolean;
    degradedSources: string[];
}

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function normalizeCandidate(value: unknown): RecommendationCandidate | null {
    const row = object(value);
    if (!row || typeof row.id !== "string") return null;
    if (
        hasNativeRecommendationIdentity(
            row as unknown as RecommendationCandidate,
        )
    ) {
        const recording = readNativeRecommendationRecording(
            row as unknown as RecommendationCandidate,
        );
        return recording
            ? toNativeRecommendationCandidate(recording, "original-radio")
            : null;
    }
    const artist = object(row?.artist);
    const album = object(row?.album);
    const provider = object(row?.provider);
    if (
        !row ||
        !artist ||
        !album ||
        typeof row.id !== "string" ||
        typeof row.title !== "string" ||
        !row.title.trim() ||
        typeof row.duration !== "number" ||
        !Number.isFinite(row.duration) ||
        row.duration < 0 ||
        typeof artist.name !== "string" ||
        !artist.name.trim() ||
        typeof album.title !== "string" ||
        (row.source !== undefined &&
            row.source !== "youtube" &&
            row.source !== "library") ||
        (row.streamSource !== undefined &&
            row.streamSource !== "youtube" &&
            row.streamSource !== "library") ||
        row.tidalTrackId != null ||
        provider?.tidalTrackId != null
    )
        return null;
    const videoId = row.youtubeVideoId ?? provider?.youtubeVideoId;
    if (videoId != null && typeof videoId !== "string") return null;
    if (
        row.youtubeVideoId &&
        provider?.youtubeVideoId &&
        row.youtubeVideoId !== provider.youtubeVideoId
    )
        return null;
    const youtube = typeof videoId === "string";
    if (youtube && (row.source === "library" || row.streamSource === "library"))
        return null;
    const prefixedVideoId = /^(?:yt:|radio:)(.+)$/.exec(row.id)?.[1];
    if (prefixedVideoId && prefixedVideoId !== videoId) return null;
    if (
        youtube
            ? !/^[A-Za-z0-9_-]{11}$/.test(videoId)
            : !/^[A-Za-z0-9_-]{1,128}$/.test(row.id)
    )
        return null;
    if (
        !youtube &&
        (row.source === "youtube" || row.streamSource === "youtube")
    )
        return null;
    const candidate: RecommendationCandidate = {
        id: youtube ? `yt:${videoId}` : row.id,
        canonicalKey: "",
        title: row.title.trim(),
        duration: Math.round(row.duration),
        trackNo:
            typeof row.trackNo === "number" && Number.isInteger(row.trackNo)
                ? row.trackNo
                : null,
        artist: {
            id: typeof artist.id === "string" ? artist.id : null,
            name: artist.name.trim(),
        },
        album: {
            id: typeof album.id === "string" ? album.id : null,
            title: album.title,
            coverArt:
                typeof album.coverArt === "string" ? album.coverArt : null,
        },
        source: youtube ? "youtube" : "library",
        streamSource: youtube ? "youtube" : "library",
        provider: {
            tidalTrackId: null,
            youtubeVideoId: youtube ? videoId : null,
        },
        ...(youtube ? { youtubeVideoId: videoId } : {}),
        candidateSources: ["original-radio"],
        providerPrior: 1,
        lane: "discovery",
    };
    candidate.canonicalKey = buildCanonicalRecordingKey(candidate);
    return candidate;
}

/** Load a bounded seed pool with the same account policy before local-selection quotas. */
export function createRadioContinuationLoader(
    dependencies: RadioContinuationLoaderDependencies,
) {
    return async (
        input: RadioContinuationInput,
        policyTime: Date,
    ): Promise<RecommendationCandidateBatch> => {
        input.execution?.check();
        const nativeSource =
            input.radioOrigin.source === "vk" ||
            input.radioOrigin.source === "yandex"
                ? input.radioOrigin.source
                : undefined;
        const preferences = nativeSource
            ? await dependencies.loadPreferences(
                  input.userId,
                  policyTime,
                  input.execution,
                  nativeSource,
              )
            : await dependencies.loadPreferences(
                  input.userId,
                  policyTime,
                  ...(input.execution ? [input.execution] : []),
              );
        input.execution?.check();
        const degradedSources = new Set(preferences.degradedSources);
        const exclusions = new Set(input.exclude);
        if (input.radioOrigin.kind === "track") {
            if (!nativeSource) exclusions.add(input.radioOrigin.id);
            exclusions.add(
                `${input.radioOrigin.source === "youtube" ? "yt" : input.radioOrigin.source}:${input.radioOrigin.id}`,
            );
        }
        const eligible = (candidate: RecommendationCandidate) => {
            const recording = readNativeRecommendationRecording(candidate);
            if (recording) {
                const credit = nativeArtistCreditKey(recording);
                return (
                    !preferences.degradedSources.includes(
                        "radio-native-artist-preferences",
                    ) &&
                    !exclusions.has(candidate.id) &&
                    !preferences.ids.has(candidate.id) &&
                    !(
                        credit &&
                        preferences.suppressedNativeCredits?.has(credit)
                    )
                );
            }
            const identity =
                candidate.source === "youtube"
                    ? candidate.provider.youtubeVideoId!
                    : `library:${candidate.id}`;
            const key = songRepeatKey(candidate.artist.name, candidate.title);
            return (
                ![
                    candidate.id,
                    identity,
                    candidate.provider.youtubeVideoId ?? "",
                ].some(
                    (id) =>
                        id && (exclusions.has(id) || preferences.ids.has(id)),
                ) &&
                !(key && preferences.songKeys.has(key)) &&
                !preferences.suppressedArtists.has(
                    candidate.artist.name.trim().toLocaleLowerCase("en-US"),
                )
            );
        };
        const admit = async (rows: unknown[]) => {
            input.execution?.check();
            const seen = new Set<string>();
            const candidates = rows.flatMap((row) => {
                const candidate = normalizeCandidate(row);
                if (
                    !candidate ||
                    !eligible(candidate) ||
                    seen.has(candidate.id)
                )
                    return [];
                seen.add(candidate.id);
                return [candidate];
            });
            const admitted = await dependencies.admitCandidates(
                input.userId,
                candidates,
                policyTime,
                [...exclusions],
                preferences.ids,
                ...(input.execution ? [input.execution] : []),
            );
            input.execution?.check();
            admitted.degradedSources.forEach((source) =>
                degradedSources.add(source),
            );
            return admitted.candidates;
        };
        const seed = await dependencies.loadSeedTracks(
            { ...input, limit: 100 },
            async (ids) => {
                input.execution?.check();
                const rows = await dependencies.loadLibraryTracks(ids);
                const candidates = await admit(rows);
                return new Set(candidates.map((candidate) => candidate.id));
            },
        );
        input.execution?.check();
        seed.degradedSources.forEach((source) => degradedSources.add(source));
        const candidates = await admit(seed.tracks);
        return {
            candidates,
            nextCursor: input.cursor >= 1_000_000 ? 0 : input.cursor + 1,
            degradedSources: [...degradedSources],
        };
    };
}

/** Serialize every ranked member once; there is no post-generation filtering. */
export function toRadioContinuationTrack(
    candidate: RecommendationCandidate,
): RadioContinuationTrack {
    if (hasNativeRecommendationIdentity(candidate)) {
        const recording = readNativeRecommendationRecording(candidate);
        if (!recording) throw new Error("Invalid ranked native recording");
        return {
            id: `${recording.provider}:${recording.id}`,
            title: recording.title,
            duration: recording.duration,
            trackNo: null,
            artist: { id: null, name: recording.artists.join(", ") },
            album: { id: null, title: "", coverArt: null },
            source: recording.provider,
            streamSource: recording.provider,
            provider: {
                source: recording.provider,
                providerTrackId: recording.id,
                youtubeVideoId: null,
                tidalTrackId: null,
            },
            musicSourceRecording: recording,
        };
    }
    return {
        id: candidate.id,
        title: candidate.title,
        duration: candidate.duration,
        trackNo: candidate.trackNo ?? null,
        artist: candidate.artist,
        album: candidate.album,
        source: candidate.source,
        provider: candidate.provider,
        ...(candidate.source === "youtube"
            ? {
                  streamSource: "youtube",
                  youtubeVideoId: candidate.provider.youtubeVideoId!,
              }
            : {}),
    };
}
