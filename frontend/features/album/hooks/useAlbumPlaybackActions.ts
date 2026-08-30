import { useAudioControls } from "@/lib/audio-context";
import { shuffleArray } from "@/utils/shuffle";
import { toast } from "sonner";
import type { Album, Track } from "../types";
import {
    selectAlbumPlaybackQueue,
    toAlbumPlaybackTrack,
} from "../albumPlayback";

type AudioControls = ReturnType<typeof useAudioControls>;

function requireAlbum(album: Album | null): album is Album {
    if (album) return true;
    toast.error("Album data not available");
    return false;
}

function playAlbum(
    album: Album | null,
    startIndex: number,
    controls: AudioControls,
): void {
    if (!requireAlbum(album)) return;
    if (!album.tracks) return;
    const selection = selectAlbumPlaybackQueue(album, startIndex);
    controls.playTracks(selection.tracks, selection.startIndex);
}

function shufflePlay(album: Album | null, controls: AudioControls): void {
    if (!requireAlbum(album)) return;
    if (!album.tracks) return;
    const selection = selectAlbumPlaybackQueue(album, 0);
    controls.playTracks(shuffleArray(selection.tracks), 0);
}

function playTrack(
    track: Track,
    album: Album | null,
    play: AudioControls["playTrack"],
): void {
    if (!requireAlbum(album)) return;
    play(toAlbumPlaybackTrack(track, album));
}

function addAllToQueue(album: Album | null, controls: AudioControls): void {
    if (!requireAlbum(album)) return;
    const tracks = selectAlbumPlaybackQueue(album, 0).tracks;
    if (tracks.length === 0) {
        toast.info("No tracks available to add");
        return;
    }
    controls.addTracksToQueue(tracks);
}

/** Provides focused album playback and queue operations. */
export function useAlbumPlaybackActions() {
    const controls = useAudioControls();
    return {
        playAlbum: (album: Album | null, startIndex = 0) =>
            playAlbum(album, startIndex, controls),
        shufflePlay: (album: Album | null) => shufflePlay(album, controls),
        playTrack: (track: Track, album: Album | null) =>
            playTrack(track, album, controls.playTrack),
        playTrackNow: (track: Track, album: Album | null) =>
            playTrack(track, album, controls.playNow),
        addToQueue: (track: Track, album: Album | null) =>
            playTrack(track, album, controls.addToQueue),
        addAllToQueue: (album: Album | null) => addAllToQueue(album, controls),
    };
}
