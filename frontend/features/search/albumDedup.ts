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

interface MergedSearchAlbums {
    libraryAlbums: Album[];
    discoverAlbums: DiscoverResult[];
}

function hasCanonicalProviderAlbumIdentity(album: DiscoverResult): boolean {
    return Boolean(
        typeof album.browseId === "string" && album.browseId.trim().length > 0,
    );
}

/** Keep one album card, preferring a provider identity that opens the full catalog. */
export function mergeSearchAlbums(
    discoverAlbums: DiscoverResult[],
    libraryAlbums: Album[],
): MergedSearchAlbums {
    const libraryKeys = new Set(
        libraryAlbums.map((album) =>
            albumKey(album.artist?.name ?? "", album.title),
        ),
    );
    const seenProviderIds = new Set<string>();
    const canonicalProviderKeys = new Set<string>();
    const mergedDiscoverAlbums: DiscoverResult[] = [];

    for (const album of discoverAlbums) {
        const providerId = album.browseId || album.id;
        if (!providerId || seenProviderIds.has(providerId)) {
            continue;
        }
        seenProviderIds.add(providerId);
        const key = albumKey(album.artist ?? "", album.name);
        const isLibraryDuplicate = libraryKeys.has(key);
        if (isLibraryDuplicate && !hasCanonicalProviderAlbumIdentity(album)) {
            continue;
        }
        if (isLibraryDuplicate) canonicalProviderKeys.add(key);
        mergedDiscoverAlbums.push(album);
    }

    return {
        libraryAlbums: libraryAlbums.filter(
            (album) =>
                !canonicalProviderKeys.has(
                    albumKey(album.artist?.name ?? "", album.title),
                ),
        ),
        discoverAlbums: mergedDiscoverAlbums,
    };
}

/** Backward-compatible provider-only view of the merged search albums. */
export function dedupeDiscoverAlbums(
    discoverAlbums: DiscoverResult[],
    libraryAlbums: Album[],
): DiscoverResult[] {
    return mergeSearchAlbums(discoverAlbums, libraryAlbums).discoverAlbums;
}
