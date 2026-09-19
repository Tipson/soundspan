import { createMusicSourceResolver } from "./resolver";
import { loadMusicSourceAdapters } from "./connections";
import { createMusicSourceCatalog } from "./catalog";

/** Shared bounded metadata search, separate from playback resolution slots. */
export const musicSourceCatalog = createMusicSourceCatalog({
    connections: loadMusicSourceAdapters,
});

/** Process-local playback leases; deployments require one playback API replica. */
export const musicSourceResolver = createMusicSourceResolver({
    connections: loadMusicSourceAdapters,
});
