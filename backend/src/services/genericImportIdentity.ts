const GENERIC_IMPORT_PLAYLIST_PREFIX = "generic-import-job:";

/**
 * Durable marker distinguishing a recovered failed commit from an ordinary
 * completed import. Claim retries use it to return the recovered operation
 * without changing the normal completed-source reimport behaviour.
 */
export const GENERIC_IMPORT_COMMIT_RECONCILIATION_WARNING =
    "Playlist creation completed; recovered import status after a persistence failure";

/**
 * Suppresses transport/concurrency retries briefly after commit recovery while
 * still allowing a later deliberate refresh of the same provider playlist.
 */
export const GENERIC_IMPORT_RECONCILIATION_DEDUPE_WINDOW_MS = 5 * 60_000;

/**
 * Builds the owner-scoped playlist marker used by durable generic imports.
 */
export function buildGenericImportPlaylistMixId(
    idempotencyKey: string,
): string {
    const normalizedKey = idempotencyKey.trim();
    if (!normalizedKey) {
        throw new Error("Playlist import idempotency key cannot be empty");
    }
    return `${GENERIC_IMPORT_PLAYLIST_PREFIX}${normalizedKey}`;
}
