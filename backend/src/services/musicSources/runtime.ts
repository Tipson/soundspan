import { createMusicSourceResolver } from "./resolver";
import { loadMusicSourceAdapters } from "./connections";
import { createMusicSourceCatalog } from "./catalog";
import { recordVerifiedMusicSourceMetadata } from "./verifiedMetadata";
import { resolveVerifiedMusicSourceIdentityInTransaction } from "./verifiedIdentity";

/** Shared bounded metadata search, separate from playback resolution slots. */
export const musicSourceCatalog = createMusicSourceCatalog({
    connections: loadMusicSourceAdapters,
});

/** Process-local playback leases; deployments require one playback API replica. */
export const musicSourceResolver = createMusicSourceResolver({
    connections: loadMusicSourceAdapters,
    recordVerified: (input, signal, budgetMs) =>
        recordVerifiedMusicSourceMetadata(
            input,
            signal,
            budgetMs,
            resolveVerifiedMusicSourceIdentityInTransaction,
        ),
});
