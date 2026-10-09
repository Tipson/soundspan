import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import type {
    PersonalizedCatalogOptions,
    PersonalizedNativeTrack,
    PersonalizedYoutubeTrack,
} from "../personalizedCatalog";
import { musicSourceCatalog } from "../musicSources/runtime";
import type { MusicSourceCatalogResult } from "../musicSources/catalog";
import { readVerifiedMusicSourceRecording } from "../musicSources/verifiedMetadata";
import {
    findMappedCanonicalCandidates,
    providerTrackIdentityToCandidate,
    type ResolvedCanonicalRecording,
} from "./canonicalIdentity";
import {
    toNativeRecommendationCandidate,
    readNativeRecommendationRecording,
} from "./nativeCandidates";
import {
    loadDislikedNativeRecordingIds,
    loadSuppressedNativeArtistCredits,
    loadVerifiedNativeCandidates,
    nativeArtistCreditKey,
} from "./nativeSourceAdmission";
import {
    loadVerifiedSourceRepeatExclusions,
    type VerifiedSourceRepeatExclusions,
} from "./verifiedSourceRepeats";
import { loadRecentlyViewedCanonicalKeys } from "../personalizedTrackPreferences";
import { recommendationFeatureStore } from "./featureStore";
import { isEarlyRecommendationSkip } from "./playbackEvidence";
import { isWaveMusicCandidate, matchesWaveMood } from "./wavePolicy";
import type { RecommendationCandidate } from "./types";

const verifiedSelect = {
    provider: true,
    providerTrackId: true,
    verifiedMetadata: true,
    metadataObservedAt: true,
    metadataConnectionVersion: true,
} as const;
const verifiedWhere: Prisma.TrackMusicSourceWhereInput = {
    provider: { in: ["vk", "yandex"] },
    verifiedMetadata: { not: Prisma.AnyNull },
    metadataObservedAt: { not: null },
    metadataConnectionVersion: { gt: 0 },
};

/** Owned playback evidence uses shared verified metadata, never the private display snapshot. */
export interface NativePersonalPlay {
    track: RecommendationCandidate;
    playedAt: Date;
    outcome: string | null;
    listenedSeconds: number | null;
    completionRatio: number | null;
}
/** Bounded exact account signals before current feedback and serving policy. */
export interface NativePersonalSignals {
    recent: RecommendationCandidate[];
    liked: RecommendationCandidate[];
    plays: NativePersonalPlay[];
    knownIds: Set<string>;
}
/** Request-owned native profile; it is never cached across users or serialized. */
export interface NativePersonalProfile extends NativePersonalSignals {
    userId: string;
    policyTime: Date;
    options: PersonalizedCatalogOptions;
    seeds: RecommendationCandidate[];
    degradedSources: string[];
}
/** Pure producer boundaries keep owner filtering independent of raw provider caches. */
export interface PersonalNativeCandidateDependencies {
    loadOwnedSignals(
        userId: string,
        now: Date,
        check: () => void,
    ): Promise<NativePersonalSignals>;
    loadExactDislikes(
        userId: string,
        ids: readonly string[],
        now: Date,
        check: () => void,
    ): Promise<Set<string>>;
    loadCredits(
        userId: string,
        now: Date,
        check: () => void,
    ): Promise<Set<string>>;
    loadMappings(
        candidates: readonly RecommendationCandidate[],
        check: () => void,
    ): Promise<readonly (ResolvedCanonicalRecording | null)[]>;
    loadCanonicalDislikes(userId: string): Promise<ReadonlySet<string>>;
    loadViewed(userId: string, keys: string[], now: Date): Promise<Set<string>>;
    loadRepeats(
        userId: string,
        now: Date,
        check: () => void,
    ): Promise<VerifiedSourceRepeatExclusions>;
    loadKnownIds(
        userId: string,
        candidates: readonly RecommendationCandidate[],
        now: Date,
        check: () => void,
    ): Promise<Set<string>>;
    enrich(
        candidates: RecommendationCandidate[],
    ): Promise<RecommendationCandidate[]>;
    getNeighbours(
        provider: "vk" | "yandex",
        id: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<MusicSourceCatalogResult>;
}
/** Fresh and older-listening pools stay separate until all sources prove emptiness. */
export interface NativePersonalCandidateBatch {
    fresh: RecommendationCandidate[];
    fallback: RecommendationCandidate[];
    degradedSources: string[];
}

function observedScore(play: NativePersonalPlay): number {
    if (play.outcome === "failed") return 0;
    if (isEarlyRecommendationSkip(play)) return -8;
    if (play.outcome === "completed" || (play.completionRatio ?? 0) >= 0.85)
        return 6;
    if (play.outcome === "skipped") return 0;
    return play.outcome === "meaningful" ||
        (play.completionRatio ?? 0) >= 0.5 ||
        (play.listenedSeconds ?? 0) >= 240
        ? 3
        : 0;
}
function strictDistinct(
    candidates: readonly RecommendationCandidate[],
): RecommendationCandidate[] {
    const seen = new Set<string>();
    return candidates.flatMap((candidate) => {
        const recording = readNativeRecommendationRecording(candidate);
        if (!recording || seen.has(candidate.id)) return [];
        seen.add(candidate.id);
        return [
            {
                ...toNativeRecommendationCandidate(
                    recording,
                    "native-personal",
                )!,
                lane: candidate.lane ?? "discovery",
            },
        ];
    });
}
function interleave<T>(groups: readonly (readonly T[])[]): T[] {
    const result: T[] = [];
    const length = Math.max(0, ...groups.map((group) => group.length));
    for (let index = 0; index < length; index++)
        for (const group of groups)
            if (index < group.length) result.push(group[index]);
    return result;
}
function period(hour: number) {
    return hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3;
}

/** Actual owned reads project only coherent, confirmed namespaces and listening measurements. */
export async function loadOwnedNativePersonalSignals(
    userId: string,
    now: Date,
    check: () => void = () => {},
): Promise<NativePersonalSignals> {
    check();
    const [likedRows, playRows] = await Promise.all([
        prisma.likedRemoteTrack.findMany({
            where: {
                userId,
                likedAt: { lte: now },
                trackMusicSource: { is: verifiedWhere },
            },
            orderBy: [{ likedAt: "desc" }, { id: "asc" }],
            take: 500,
            select: {
                userId: true,
                likedAt: true,
                trackMusicSource: { select: verifiedSelect },
            },
        }),
        prisma.play.findMany({
            where: {
                userId,
                playedAt: { lte: now },
                OR: (["vk", "yandex"] as const).map((provider) => ({
                    source: provider === "vk" ? "VK" : "YANDEX",
                    trackMusicSource: { is: { ...verifiedWhere, provider } },
                })),
            },
            orderBy: [{ playedAt: "desc" }, { id: "asc" }],
            take: 1000,
            select: {
                userId: true,
                source: true,
                playedAt: true,
                outcome: true,
                listenedSeconds: true,
                completionRatio: true,
                trackMusicSource: { select: verifiedSelect },
            },
        }),
    ]);
    check();
    const liked = likedRows.flatMap((row) => {
        if (
            row.userId !== userId ||
            !(row.likedAt instanceof Date) ||
            !Number.isFinite(row.likedAt.getTime()) ||
            row.likedAt > now
        )
            return [];
        const recording = readVerifiedMusicSourceRecording(
            row.trackMusicSource,
        );
        return recording
            ? (toNativeRecommendationCandidate(
                  recording,
                  "native-personal-liked",
              ) ?? [])
            : [];
    });
    const plays = playRows.flatMap((row): NativePersonalPlay[] => {
        if (
            row.userId !== userId ||
            !(row.playedAt instanceof Date) ||
            !Number.isFinite(row.playedAt.getTime()) ||
            row.playedAt > now
        )
            return [];
        const recording = readVerifiedMusicSourceRecording(
            row.trackMusicSource,
        );
        if (
            !recording ||
            row.source !== (recording.provider === "vk" ? "VK" : "YANDEX")
        )
            return [];
        const track = toNativeRecommendationCandidate(
            recording,
            "native-personal-play",
        );
        return track
            ? [
                  {
                      track,
                      playedAt: row.playedAt,
                      outcome: row.outcome,
                      listenedSeconds: row.listenedSeconds,
                      completionRatio: row.completionRatio,
                  },
              ]
            : [];
    });
    const recent = strictDistinct(
        plays
            .filter((play) => observedScore(play) > 0)
            .map((play) => play.track),
    );
    return {
        recent,
        liked: strictDistinct(liked),
        plays,
        knownIds: new Set([
            ...liked.map((track) => track.id),
            ...plays
                .filter((play) => play.outcome !== "failed")
                .map((play) => play.track.id),
        ]),
    };
}

/** Targeted historical novelty avoids losing an old exact play behind a bounded signal window. */
export async function loadKnownNativePersonalIds(
    userId: string,
    candidates: readonly RecommendationCandidate[],
    now: Date,
    check: () => void = () => {},
): Promise<Set<string>> {
    const values = strictDistinct(candidates),
        known = new Set<string>();
    for (let offset = 0; offset < values.length; offset += 250) {
        check();
        const batch = values.slice(offset, offset + 250),
            requested = new Set(batch.map((track) => track.id));
        const rows = await prisma.trackMusicSource.findMany({
            where: {
                ...verifiedWhere,
                OR: (["vk", "yandex"] as const).flatMap((provider) => {
                    const ids = batch
                        .filter((track) => track.source === provider)
                        .map((track) => track.musicSourceRecording!.id);
                    return ids.length
                        ? [
                              {
                                  provider,
                                  providerTrackId: { in: ids },
                                  OR: [
                                      {
                                          likedTracks: {
                                              some: {
                                                  userId,
                                                  likedAt: { lte: now },
                                              },
                                          },
                                      },
                                      {
                                          plays: {
                                              some: {
                                                  userId,
                                                  source:
                                                      provider === "vk"
                                                          ? "VK"
                                                          : "YANDEX",
                                                  playedAt: { lte: now },
                                                  OR: [
                                                      { outcome: null },
                                                      {
                                                          outcome: {
                                                              not: "failed",
                                                          },
                                                      },
                                                  ],
                                              },
                                          },
                                      },
                                  ],
                              },
                          ]
                        : [];
                }),
            },
            take: batch.length,
            select: verifiedSelect,
        });
        check();
        for (const row of rows) {
            const recording = readVerifiedMusicSourceRecording(row);
            const id = recording
                ? `${recording.provider}:${recording.id}`
                : null;
            if (id && requested.has(id)) known.add(id);
        }
    }
    check();
    return known;
}

/** Existing three radio slots are shared fairly between actual source groups, with cursor rotation. */
export function selectPersonalRadioSeeds(
    youtube: PersonalizedYoutubeTrack[],
    native: RecommendationCandidate[],
    cursor: number,
): { youtube: PersonalizedYoutubeTrack[]; native: RecommendationCandidate[] } {
    const groups: Array<
        Array<
            | { kind: "youtube"; track: PersonalizedYoutubeTrack }
            | { kind: "native"; track: RecommendationCandidate }
        >
    > = [];
    if (youtube.length)
        groups.push(youtube.map((track) => ({ kind: "youtube", track })));
    for (const provider of ["vk", "yandex"] as const) {
        const rows = native.filter(
            (track) =>
                track.source === provider &&
                readNativeRecommendationRecording(track),
        );
        if (rows.length)
            groups.push(rows.map((track) => ({ kind: "native", track })));
    }
    const offset = groups.length ? cursor % groups.length : 0;
    const chosen = interleave([
        ...groups.slice(offset),
        ...groups.slice(0, offset),
    ]).slice(0, 3);
    return {
        youtube: chosen.flatMap((entry) =>
            entry.kind === "youtube" ? [entry.track] : [],
        ),
        native: chosen.flatMap((entry) =>
            entry.kind === "native" ? [entry.track] : [],
        ),
    };
}

/** Native public projection uses only the exact sanitized recording. */
export function toNativePersonalizedTrack(
    candidate: RecommendationCandidate,
): PersonalizedNativeTrack | null {
    const recording = readNativeRecommendationRecording(candidate);
    if (!recording) return null;
    const artist = { id: null, name: recording.artists.join(", ") };
    return {
        id: `${recording.provider}:${recording.id}`,
        title: recording.title,
        duration: recording.duration,
        trackNo: null,
        artist,
        album: { id: null, title: "", coverArt: "", artist },
        source: recording.provider,
        streamSource: recording.provider,
        musicSourceRecording: recording,
        provider: {
            source: recording.provider,
            providerTrackId: recording.id,
            tidalTrackId: null,
            youtubeVideoId: null,
        },
    };
}

/** Owned native seeds and raw neighbours cross the same fresh personal admission on each request. */
export class PersonalNativeCandidateService {
    constructor(
        private readonly dependencies: PersonalNativeCandidateDependencies,
    ) {}

    /** Prepare taste seeds with current owner feedback before source allocation; seed listening is not a serving repeat. */
    async prepare(
        userId: string,
        policyTime: Date,
        options: PersonalizedCatalogOptions,
    ): Promise<NativePersonalProfile> {
        const check = options.execution?.check ?? (() => {});
        check();
        const empty = (): NativePersonalProfile => ({
            userId,
            policyTime,
            options,
            recent: [],
            liked: [],
            plays: [],
            knownIds: new Set(),
            seeds: [],
            degradedSources: [],
        });
        let owned: NativePersonalSignals;
        try {
            owned = await this.dependencies.loadOwnedSignals(
                userId,
                policyTime,
                check,
            );
            check();
        } catch {
            check();
            return { ...empty(), degradedSources: ["native-personal-signals"] };
        }
        const all = strictDistinct([...owned.recent, ...owned.liked]);
        if (!all.length)
            return { ...empty(), knownIds: owned.knownIds, plays: owned.plays };
        const initial = {
            ...owned,
            userId,
            policyTime,
            options,
            seeds: [],
            degradedSources: [],
        };
        const admitted = await this.admit(initial, all, true);
        const accepted = new Map(
            admitted.fresh.map((track) => [track.id, track]),
        );
        const scores = new Map<string, number>();
        for (const liked of owned.liked) scores.set(liked.id, 12);
        for (const play of owned.plays.slice(0, 100)) {
            const score = observedScore(play);
            scores.set(play.track.id, (scores.get(play.track.id) ?? 0) + score);
            if (score > 0 && options.listeningContext) {
                const localHour = new Date(
                    play.playedAt.getTime() +
                        options.listeningContext.timezoneOffsetMinutes * 60_000,
                ).getUTCHours();
                if (
                    period(localHour) ===
                    period(options.listeningContext.localHour)
                )
                    scores.set(
                        play.track.id,
                        (scores.get(play.track.id) ?? 0) + Math.min(5, score),
                    );
            }
        }
        const eligible = admitted.fresh.filter(
            (track) => !scores.has(track.id) || (scores.get(track.id) ?? 0) > 0,
        );
        eligible.sort(
            (left, right) =>
                (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0),
        );
        const groups = (["vk", "yandex"] as const).map((provider) =>
            eligible.filter((track) => track.source === provider),
        );
        const ordered = interleave(groups),
            rotated = ordered.length
                ? [
                      ...ordered.slice((options.cursor ?? 0) % ordered.length),
                      ...ordered.slice(
                          0,
                          (options.cursor ?? 0) % ordered.length,
                      ),
                  ]
                : [];
        const credits = new Set<string>(),
            identities = new Set<string>();
        const seeds = rotated
            .filter((track) => {
                const credit =
                    nativeArtistCreditKey(track.musicSourceRecording) ??
                    track.id;
                const identity = JSON.stringify(
                    track.canonicalRecordingId
                        ? ["canonical", track.canonicalRecordingId]
                        : ["provider", track.id],
                );
                if (credits.has(credit) || identities.has(identity))
                    return false;
                credits.add(credit);
                identities.add(identity);
                return true;
            })
            .slice(0, 3);
        return {
            ...initial,
            recent: owned.recent.flatMap(
                (track) => accepted.get(track.id) ?? [],
            ),
            liked: owned.liked.flatMap((track) => accepted.get(track.id) ?? []),
            seeds,
            degradedSources: admitted.degradedSources,
        };
    }

    /** Validate selected prepared seeds, fetch up to100 raw per slot, then admit before any serving quota. */
    async getBatch(
        profile: NativePersonalProfile,
        selectedSeeds: readonly RecommendationCandidate[],
    ): Promise<NativePersonalCandidateBatch> {
        const check = profile.options.execution?.check ?? (() => {});
        check();
        if (
            selectedSeeds.length > 3 ||
            new Set(selectedSeeds.map((track) => track.id)).size !==
                selectedSeeds.length
        )
            throw new RangeError("Native radio budget exceeded");
        const prepared = new Map(
            profile.seeds.map((track) => [track.id, track]),
        );
        for (const selected of selectedSeeds)
            if (
                !prepared.has(selected.id) ||
                !readNativeRecommendationRecording(selected)
            )
                throw new TypeError("Unowned native seed");
        const degraded = new Set(profile.degradedSources);
        const queues = await Promise.all(
            selectedSeeds.map(async (selected) => {
                const seed = prepared.get(selected.id)!.musicSourceRecording!;
                check();
                const timeout = AbortSignal.timeout(
                    Math.min(
                        4000,
                        profile.options.execution?.remainingMs() ?? 4000,
                    ),
                );
                const signal = profile.options.sourceSignal
                    ? AbortSignal.any([profile.options.sourceSignal, timeout])
                    : timeout;
                try {
                    const result = await this.dependencies.getNeighbours(
                        seed.provider,
                        seed.id,
                        100,
                        signal,
                    );
                    check();
                    if (result.unavailable.length)
                        degraded.add(`${seed.provider}-personal`);
                    return result.tracks.slice(0, 100).flatMap((recording) => {
                        const candidate = toNativeRecommendationCandidate(
                            recording,
                            "native-personal-similar",
                        );
                        return candidate?.source === seed.provider &&
                            !prepared.has(candidate.id)
                            ? [candidate]
                            : [];
                    });
                } catch {
                    check();
                    degraded.add(`${seed.provider}-personal`);
                    return [];
                }
            }),
        );
        check();
        const all = strictDistinct([
            ...profile.recent.map((track) => ({
                ...track,
                lane: "listenAgain" as const,
            })),
            ...profile.liked.map((track) => ({
                ...track,
                lane: "quickPicks" as const,
            })),
            ...interleave(queues),
        ]);
        if (!all.length)
            return { fresh: [], fallback: [], degradedSources: [...degraded] };
        const result = await this.admit(profile, all, false);
        return {
            ...result,
            degradedSources: [
                ...new Set([...degraded, ...result.degradedSources]),
            ],
        };
    }

    /** Reusable current admission for raw personal or finite-mix rows, without upstream authority or weak matching. */
    async admit(
        profile: NativePersonalProfile,
        values: readonly RecommendationCandidate[],
        seedOnly = false,
    ): Promise<NativePersonalCandidateBatch> {
        const check = profile.options.execution?.check ?? (() => {});
        check();
        const candidates = strictDistinct(values).filter(isWaveMusicCandidate);
        if (!candidates.length)
            return { fresh: [], fallback: [], degradedSources: [] };
        try {
            const excludedIds = new Set(
                seedOnly ? [] : (profile.options.excludeVideoIds ?? []),
            );
            const excludedNative =
                !seedOnly &&
                [...excludedIds].some((id) => /^(vk|yandex):/.test(id))
                    ? await loadVerifiedNativeCandidates(
                          [...excludedIds],
                          check,
                      )
                    : [];
            check();
            const excludedLegacy = [...excludedIds].flatMap((id) => {
                const video = id.replace(/^yt:/, "");
                return /^[A-Za-z0-9_-]{1,64}$/.test(video)
                    ? [
                          providerTrackIdentityToCandidate({
                              source: "youtube",
                              providerTrackId: video,
                              title: "",
                              artist: "",
                          }),
                      ]
                    : [];
            });
            const [downs, credits, mappings, canonicalDowns] =
                await Promise.all([
                    this.dependencies.loadExactDislikes(
                        profile.userId,
                        candidates.map((track) => track.id),
                        profile.policyTime,
                        check,
                    ),
                    this.dependencies.loadCredits(
                        profile.userId,
                        profile.policyTime,
                        check,
                    ),
                    this.dependencies.loadMappings(
                        [...candidates, ...excludedNative, ...excludedLegacy],
                        check,
                    ),
                    this.dependencies.loadCanonicalDislikes(profile.userId),
                ]);
            check();
            let mapped = candidates.map((track, index) =>
                mappings[index]
                    ? {
                          ...track,
                          canonicalRecordingId: mappings[index]!.id,
                          canonicalKey: mappings[index]!.canonicalKey,
                      }
                    : track,
            );
            const excludedKeys = new Set(
                mappings
                    .slice(candidates.length)
                    .flatMap((mapping) =>
                        mapping ? [mapping.canonicalKey] : [],
                    ),
            );
            const repeatEnabled =
                !seedOnly && profile.options.surface !== "home";
            const [viewed, repeats, known] = await Promise.all([
                seedOnly || profile.options.surface === "home"
                    ? Promise.resolve(new Set<string>())
                    : this.dependencies.loadViewed(
                          profile.userId,
                          mapped.map((track) => track.canonicalKey),
                          profile.policyTime,
                      ),
                repeatEnabled
                    ? this.dependencies.loadRepeats(
                          profile.userId,
                          profile.policyTime,
                          check,
                      )
                    : Promise.resolve({
                          ids: new Set<string>(),
                          hardIds: new Set<string>(),
                      }),
                !seedOnly && profile.options.mode === "new"
                    ? this.dependencies.loadKnownIds(
                          profile.userId,
                          candidates,
                          profile.policyTime,
                          check,
                      )
                    : Promise.resolve(new Set<string>()),
            ]);
            check();
            if (
                !seedOnly &&
                profile.options.surface === "wave" &&
                ["calm", "focus", "energetic", "workout"].includes(
                    profile.options.mood ?? "",
                )
            ) {
                mapped = await this.dependencies.enrich(mapped);
                check();
            }
            const seen = new Set<string>();
            const eligible = mapped.filter((track) => {
                const credit = nativeArtistCreditKey(
                        track.musicSourceRecording,
                    ),
                    key = JSON.stringify(
                        track.canonicalRecordingId
                            ? ["canonical", track.canonicalRecordingId]
                            : ["provider", track.id],
                    );
                if (
                    seen.has(key) ||
                    downs.has(track.id) ||
                    (credit && credits.has(credit)) ||
                    canonicalDowns.has(track.canonicalKey) ||
                    excludedIds.has(track.id) ||
                    excludedKeys.has(track.canonicalKey) ||
                    viewed.has(track.canonicalKey) ||
                    repeats.hardIds.has(track.id) ||
                    repeats.hardIds.has(track.canonicalKey) ||
                    (!seedOnly &&
                        profile.options.mode === "new" &&
                        (known.has(track.id) ||
                            profile.knownIds.has(track.id))) ||
                    (!seedOnly &&
                        profile.options.surface === "wave" &&
                        !matchesWaveMood(track, profile.options.mood))
                )
                    return false;
                seen.add(key);
                return true;
            });
            const fresh = eligible.filter(
                (track) =>
                    !repeats.ids.has(track.id) &&
                    !repeats.ids.has(track.canonicalKey),
            );
            const fallback =
                profile.options.mode === "new" ||
                profile.options.surface === "weekly"
                    ? []
                    : eligible.filter(
                          (track) =>
                              repeats.ids.has(track.id) ||
                              repeats.ids.has(track.canonicalKey),
                      );
            return { fresh, fallback, degradedSources: [] };
        } catch {
            check();
            return {
                fresh: [],
                fallback: [],
                degradedSources: ["native-personal-admission"],
            };
        }
    }
}

/** Actual runtime shares the bounded metadata catalog and read-only owner admission. */
export const personalNativeCandidateService =
    new PersonalNativeCandidateService({
        loadOwnedSignals: loadOwnedNativePersonalSignals,
        loadExactDislikes: loadDislikedNativeRecordingIds,
        loadCredits: loadSuppressedNativeArtistCredits,
        loadMappings: findMappedCanonicalCandidates,
        loadCanonicalDislikes: (userId) =>
            recommendationFeatureStore.loadDislikedCanonicalKeys(userId),
        loadViewed: loadRecentlyViewedCanonicalKeys,
        loadRepeats: loadVerifiedSourceRepeatExclusions,
        loadKnownIds: loadKnownNativePersonalIds,
        enrich: (candidates) =>
            recommendationFeatureStore.enrichCandidates(candidates),
        getNeighbours: (provider, id, limit, signal) =>
            musicSourceCatalog.recommendations(provider, id, limit, signal),
    });
