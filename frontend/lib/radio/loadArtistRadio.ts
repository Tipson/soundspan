import { api } from "@/lib/api";
import { normalizeRadioTracks } from "./loadTrackRadio";
import { requestRadioQueue } from "./radioRequestIntent";
import { withPlaybackRadioOrigin } from "./playbackRadioOrigin";

/** Loads a playable artist queue only while its playback intent is current. */
export async function loadArtistRadio(
    artistId: string,
    artistName?: string,
    source?: "library" | "discovery",
) {
    return requestRadioQueue(async () => {
        const byName =
            (source === "discovery" || artistId.startsWith("ytartist:")) &&
            artistName?.trim();
        const response = await api.getRadioTracks(
            byName ? "artist-name" : "artist",
            byName || artistId,
        );
        return normalizeRadioTracks(response.tracks ?? []).map((track) =>
            withPlaybackRadioOrigin(
                track,
                byName
                    ? { kind: "artist", source: "discovery", name: byName }
                    : { kind: "artist", source: "library", id: artistId },
            ),
        );
    });
}
