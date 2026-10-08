import { readVerifiedMusicSourceRecording } from "./musicSources/verifiedMetadata";

/** Project a confirmed provider namespace for the owner's liked list, without playback entitlement claims. */
export function toVerifiedMusicSourceLikedTrack(
    namespace: unknown,
    likedAt: Date,
) {
    const recording = readVerifiedMusicSourceRecording(namespace);
    if (!recording) return null;
    const artist = { id: null, name: recording.artists.join(", ") };
    return {
        id: `${recording.provider}:${recording.id}`,
        title: recording.title,
        duration: recording.duration,
        trackNo: null,
        filePath: null,
        likedAt: likedAt.toISOString(),
        source: recording.provider,
        mediaSource: recording.provider,
        streamSource: recording.provider,
        provider: {
            source: recording.provider,
            providerTrackId: recording.id,
            youtubeVideoId: null,
            tidalTrackId: null,
        },
        artist,
        album: { id: null, title: "", coverArt: null, artist },
        musicSourceRecording: recording,
    };
}
