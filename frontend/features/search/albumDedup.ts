import type { Album, DiscoverResult } from "./types";

const normalizeAlbumPart = (value: string): string =>
    value
        .toLowerCase()
        .replace(
            /\s*(?:\([^)]*(?:deluxe|remaster(?:ed)?|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|mono|stereo)[^)]*\)|\[[^\]]*(?:deluxe|remaster(?:ed)?|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|mono|stereo)[^\]]*\])\s*$/gi,
            "",
        )
        .replace(/\s*\(\d{4}\)\s*$/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "");

const albumKey = (artist: string, title: string): string =>
    `${normalizeAlbumPart(artist)}::${normalizeAlbumPart(title)}`;

/** Remove provider albums already owned locally and duplicate provider rows. */
export function dedupeDiscoverAlbums(
    discoverAlbums: DiscoverResult[],
    libraryAlbums: Album[],
): DiscoverResult[] {
    const ownedKeys = new Set(
        libraryAlbums.map((album) =>
            albumKey(album.artist?.name ?? "", album.title),
        ),
    );
    const seenProviderIds = new Set<string>();

    return discoverAlbums.filter((album) => {
        const providerId = album.browseId || album.id;
        if (!providerId || seenProviderIds.has(providerId)) {
            return false;
        }
        seenProviderIds.add(providerId);
        return !ownedKeys.has(albumKey(album.artist ?? "", album.name));
    });
}
