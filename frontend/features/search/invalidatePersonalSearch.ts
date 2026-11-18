import type { Query, QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { remainingSearchRetryMs } from "./searchRetryPolicy";

function heldRate(query: Query): boolean {
    return (
        Math.max(
            remainingSearchRetryMs(query.state.error),
            remainingSearchRetryMs(query.state.fetchFailureReason),
        ) > 0
    );
}

/** Retire even a first private fill before requesting current liked membership. */
export async function invalidatePersonalSearch(
    client: Pick<
        QueryClient,
        "cancelQueries" | "invalidateQueries" | "refetchQueries"
    >,
    scope: "library" | "saved" = "library",
): Promise<void> {
    const queryKey =
        scope === "library"
            ? queryKeys.librarySearchAll()
            : queryKeys.savedMusicSearchAll();
    // Revert only this search namespace to its last completed data. Preference
    // settlement/rollback caches and public provider queries have other keys.
    // A retryer waiting on a received 429/503 has no old successful body to
    // publish. Keep its receipt/backoff instead of cancelling it into an early
    // replacement wire. Every ordinary pending read still gets retired.
    await client.cancelQueries(
        { queryKey, predicate: (query) => !heldRate(query) },
        { revert: true },
    );
    await client.invalidateQueries({ queryKey, refetchType: "none" });
    await client.refetchQueries(
        { queryKey, type: "active", predicate: (query) => !heldRate(query) },
        { cancelRefetch: false },
    );
}
