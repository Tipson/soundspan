import { createMusicSourceResolver } from "./resolver";
import { loadMusicSourceAdapters } from "./connections";

/** Process-local playback leases; deployments require one playback API replica. */
export const musicSourceResolver = createMusicSourceResolver({
    connections: loadMusicSourceAdapters,
});
