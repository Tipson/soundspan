export interface SpotifyTrack {
    spotifyId: string;
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    isrc: string | null;
    durationMs: number;
    trackNumber: number;
    previewUrl: string | null;
    coverUrl: string | null;
}

export interface SpotifyPlaylist {
    id: string;
    name: string;
    description: string | null;
    owner: string;
    imageUrl: string | null;
    trackCount: number;
    tracks: SpotifyTrack[];
    isPublic: boolean;
}

export interface SpotifyAlbum {
    id: string;
    name: string;
    artist: string;
    artistId: string;
    imageUrl: string | null;
    releaseDate: string | null;
    trackCount: number;
}

export interface SpotifyPlaylistPreview {
    id: string;
    name: string;
    description: string | null;
    owner: string;
    imageUrl: string | null;
    trackCount: number;
}
