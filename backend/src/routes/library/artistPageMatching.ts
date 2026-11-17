import {
    normalizeTrackTitle,
    stripTrackSuffix,
} from "../../utils/trackMatching";
import {
    normalizeAlbumTitle,
    stripAlbumEdition,
} from "../../utils/artistNormalization";
import { stripDelimitedSegments } from "../../utils/stripDelimitedSegments";
import { isValidMbid } from "../../utils/musicIds";
import { currentRemoteAlbumMatch } from "../../services/remoteAlbumMatchProjection";

type Titled = Readonly<{ title: string }>;
const FEATURE_SUFFIX = /^(?:feat\.?|ft\.?|featuring)\b/i;

function stripFeatureSuffix(title: string): string {
    return stripDelimitedSegments(
        stripTrackSuffix(title),
        "(",
        ")",
        (segment) => FEATURE_SUFFIX.test(segment.trim()),
        " ",
    );
}

function trackTitleKeys(title: string): readonly string[] {
    const rawFallback = title.toLowerCase();
    const normalizedTitle = normalizeTrackTitle(title) || rawFallback;
    const normalizedWithoutSuffix =
        normalizeTrackTitle(stripFeatureSuffix(title)) || rawFallback;
    return normalizedTitle === normalizedWithoutSuffix
        ? [normalizedTitle]
        : [normalizedTitle, normalizedWithoutSuffix];
}

/** Builds a first-writer-wins lookup for normalized artist-page track titles. */
export function buildArtistTrackTitleIndex<T extends Titled>(
    tracks: readonly T[],
): ReadonlyMap<string, T> {
    const tracksByTitle = new Map<string, T>();
    for (const track of tracks) {
        for (const key of trackTitleKeys(track.title)) {
            if (!tracksByTitle.has(key)) tracksByTitle.set(key, track);
        }
    }
    return tracksByTitle;
}

/** Finds a library track through the same normalized title variants. */
export function findArtistTrackByTitle<T extends Titled>(
    tracksByTitle: ReadonlyMap<string, T>,
    title: string,
): T | undefined {
    for (const key of trackTitleKeys(title)) {
        const track = tracksByTitle.get(key);
        if (track) return track;
    }
    return undefined;
}

function normalizeDiscographyAlbumTitle(title: string): string {
    return normalizeAlbumTitle(stripAlbumEdition(title));
}

type DiscographyAlbum = Titled & {
    rgMbid?: string | null;
    location?: string;
    artist?: { name: string; mbid: string | null };
    matchedRgMbid?: string | null;
    rgMbidCheckedAt?: Date | null;
    rgMbidMatchInputHash?: string | null;
};

function canonicalAlbumIdentity(album: DiscographyAlbum): string | null {
    if (isValidMbid(album.rgMbid)) return album.rgMbid!.toLowerCase();
    if (album.location === "REMOTE" && album.rgMbid && album.artist) {
        return (
            currentRemoteAlbumMatch({
                ...album,
                location: album.location,
                rgMbid: album.rgMbid,
                artist: album.artist,
            })?.toLowerCase() ?? null
        );
    }
    return null;
}

function supportsLegacyTitleFallback(album: DiscographyAlbum): boolean {
    return album.location !== "REMOTE" && !album.rgMbid?.startsWith("remote:");
}

/** Preserve distinct canonical identities; unresolved streaming rows never hide acquisition cards by title. */
export function filterDistinctDiscographyAlbums<
    TOwned extends DiscographyAlbum,
    TRemote extends DiscographyAlbum,
>(ownedAlbums: readonly TOwned[], remoteAlbums: readonly TRemote[]): TRemote[] {
    const ownedIdentities = new Set(
        ownedAlbums.map(canonicalAlbumIdentity).filter(Boolean),
    );
    const ownedTitles = new Set(
        ownedAlbums
            .filter(
                (album) =>
                    !canonicalAlbumIdentity(album) &&
                    supportsLegacyTitleFallback(album),
            )
            .map((album) => normalizeDiscographyAlbumTitle(album.title)),
    );
    return remoteAlbums.filter((album) => {
        const identity = canonicalAlbumIdentity(album);
        if (identity) return !ownedIdentities.has(identity);
        return (
            !supportsLegacyTitleFallback(album) ||
            !ownedTitles.has(normalizeDiscographyAlbumTitle(album.title))
        );
    });
}
