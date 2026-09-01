import { resetOrderedTrackPreferenceMutations } from "@/hooks/trackPreferenceOptimistic";
import { clearCachedAuthUser } from "@/lib/auth-offline-session";
import {
    advanceAuthRuntimeGeneration,
    AUTH_RUNTIME_REVOKED_EVENT,
} from "@/lib/auth-runtime-generation";
import {
    getQueryClient,
    retireQueryClientForAuthRuntime,
} from "@/lib/query-client";
import { revokeUserPlaybackStorage } from "@/lib/userPlaybackStorage";

export { AUTH_RUNTIME_REVOKED_EVENT } from "@/lib/auth-runtime-generation";

/**
 * Synchronously retire every user-owned browser runtime before credentials
 * are removed or replaced. The event only clears same-tab React state; the
 * durable and async state is revoked here even when no provider is mounted.
 */
export function revokeAuthenticatedRuntime(input?: {
    notifyAuthProvider?: boolean;
}): void {
    advanceAuthRuntimeGeneration();
    clearCachedAuthUser();
    revokeUserPlaybackStorage();

    const queryClient = getQueryClient();
    resetOrderedTrackPreferenceMutations(queryClient);
    retireQueryClientForAuthRuntime(queryClient);

    if (input?.notifyAuthProvider !== false && typeof window !== "undefined") {
        window.dispatchEvent(new Event(AUTH_RUNTIME_REVOKED_EVENT));
    }
}
