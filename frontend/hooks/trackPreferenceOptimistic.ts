import type {
    TrackPreferenceResponse,
    TrackPreferenceSignal,
} from "../lib/api";

/**
 * Executes buildOptimisticTrackPreferenceResponse.
 */
export function buildOptimisticTrackPreferenceResponse(
    trackId: string,
    signal: TrackPreferenceSignal,
): TrackPreferenceResponse {
    const now = new Date().toISOString();
    const state =
        signal === "thumbs_up"
            ? "liked"
            : signal === "thumbs_down"
              ? "disliked"
              : "neutral";

    return {
        trackId,
        signal,
        state,
        score: signal === "thumbs_up" ? 1 : signal === "thumbs_down" ? -1 : 0,
        likedAt: signal === "thumbs_up" ? now : null,
        dislikedAt: signal === "thumbs_down" ? now : null,
        updatedAt: now,
    };
}

export interface TrackPreferenceOptimisticQueryClient {
    cancelQueries: (options: {
        queryKey: readonly [string, string];
        exact: boolean;
    }) => Promise<unknown>;
    getQueryData: <T>(queryKey: readonly [string, string]) => T | undefined;
    setQueryData: (
        queryKey: readonly [string, string],
        data: TrackPreferenceResponse,
    ) => void;
}

interface TrackPreferenceMutationLane {
    identity: object;
    nextGeneration: number;
    latestGeneration: number;
    latestSettled: boolean;
    inFlightGenerations: Set<number>;
    rollbackPreference: TrackPreferenceResponse | null;
}

export interface OrderedTrackPreferenceMutationContext {
    canonicalQueryKey: readonly ["track-preference", string];
    previousPreference: TrackPreferenceResponse | undefined;
    generation: number;
    laneIdentity: object;
}

export type OrderedTrackPreferenceMutationCompletion =
    | { status: "success"; preference: TrackPreferenceResponse }
    | { status: "error" };

export interface OrderedTrackPreferenceMutationResult {
    isLatest: boolean;
    rollbackPreference: TrackPreferenceResponse | null;
}

const mutationLanesByQueryClient = new WeakMap<
    object,
    Map<string, TrackPreferenceMutationLane>
>();

function getMutationLanes(
    queryClient: TrackPreferenceOptimisticQueryClient,
): Map<string, TrackPreferenceMutationLane> {
    const clientKey = queryClient as object;
    const existingLanes = mutationLanesByQueryClient.get(clientKey);
    if (existingLanes) return existingLanes;

    const newLanes = new Map<string, TrackPreferenceMutationLane>();
    mutationLanesByQueryClient.set(clientKey, newLanes);
    return newLanes;
}

/**
 * Executes applyOptimisticTrackPreferenceMutation.
 */
export function applyOptimisticTrackPreferenceMutation(
    queryClient: TrackPreferenceOptimisticQueryClient,
    trackId: string,
    nextSignal: TrackPreferenceSignal,
) {
    const canonicalQueryKey = ["track-preference", trackId] as const;

    // Fire cancellation in the background so optimistic UI updates are immediate.
    void queryClient.cancelQueries({
        queryKey: canonicalQueryKey,
        exact: true,
    });

    const previousPreference =
        queryClient.getQueryData<TrackPreferenceResponse>(canonicalQueryKey);
    queryClient.setQueryData(
        canonicalQueryKey,
        buildOptimisticTrackPreferenceResponse(trackId, nextSignal),
    );

    return { canonicalQueryKey, previousPreference };
}

/**
 * Starts one cross-component preference mutation generation for a track.
 *
 * The first overlapping mutation captures the last stable cache value. Newer
 * optimistic updates share that rollback point until one of them settles, so a
 * failed newest request never rolls back to an older in-flight optimistic value.
 */
export function applyOrderedOptimisticTrackPreferenceMutation(
    queryClient: TrackPreferenceOptimisticQueryClient,
    trackId: string,
    nextSignal: TrackPreferenceSignal,
): OrderedTrackPreferenceMutationContext {
    const canonicalQueryKey = ["track-preference", trackId] as const;
    const lanes = getMutationLanes(queryClient);
    let lane = lanes.get(trackId);
    const currentPreference =
        queryClient.getQueryData<TrackPreferenceResponse>(canonicalQueryKey) ??
        null;

    if (!lane) {
        lane = {
            identity: {},
            nextGeneration: 0,
            latestGeneration: 0,
            latestSettled: true,
            inFlightGenerations: new Set<number>(),
            rollbackPreference: currentPreference,
        };
        lanes.set(trackId, lane);
    } else if (lane.latestSettled) {
        // An older generation may still be finishing, but the current cache is
        // now the stable rollback point for this new user intent.
        lane.rollbackPreference = currentPreference;
    }

    const generation = lane.nextGeneration + 1;
    lane.nextGeneration = generation;
    lane.latestGeneration = generation;
    lane.latestSettled = false;
    lane.inFlightGenerations.add(generation);

    const optimisticContext = applyOptimisticTrackPreferenceMutation(
        queryClient,
        trackId,
        nextSignal,
    );

    return {
        ...optimisticContext,
        generation,
        laneIdentity: lane.identity,
    };
}

/**
 * Completes a preference generation and reports whether it still represents
 * the newest user intent for this query client and canonical track.
 */
export function completeOrderedTrackPreferenceMutation(
    queryClient: TrackPreferenceOptimisticQueryClient,
    context: OrderedTrackPreferenceMutationContext,
    completion: OrderedTrackPreferenceMutationCompletion,
): OrderedTrackPreferenceMutationResult {
    const clientKey = queryClient as object;
    const lanes = mutationLanesByQueryClient.get(clientKey);
    const trackId = context.canonicalQueryKey[1];
    const lane = lanes?.get(trackId);

    if (
        !lane ||
        lane.identity !== context.laneIdentity ||
        !lane.inFlightGenerations.has(context.generation)
    ) {
        return { isLatest: false, rollbackPreference: null };
    }

    const isLatest = lane.latestGeneration === context.generation;
    if (isLatest) {
        lane.latestSettled = true;
        if (completion.status === "success") {
            lane.rollbackPreference = completion.preference;
        }
    }

    const rollbackPreference = lane.rollbackPreference;
    lane.inFlightGenerations.delete(context.generation);
    if (lane.inFlightGenerations.size === 0) {
        lanes?.delete(trackId);
        if (lanes?.size === 0) {
            mutationLanesByQueryClient.delete(clientKey);
        }
    }

    return { isLatest, rollbackPreference };
}

/**
 * Retires every pending preference generation for an authentication session.
 * The opaque lane identity prevents an old callback from matching a new lane
 * even when both happen to use generation one for the same canonical track.
 */
export function resetOrderedTrackPreferenceMutations(
    queryClient: TrackPreferenceOptimisticQueryClient,
): void {
    mutationLanesByQueryClient.delete(queryClient as object);
}
