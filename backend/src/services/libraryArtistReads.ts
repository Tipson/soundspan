import { Prisma, type AlbumLocation } from "@prisma/client";
import { prisma } from "../utils/db";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../utils/librarySorting";

/** Identity fields accepted by the shared artist read. */
export interface LibraryArtistLookup {
    id: string;
    name?: string;
    mbid?: string;
}

/** Visibility, ordering, and paging controls for a shared artist read. */
export interface LibraryArtistReadOptions {
    lookup: LibraryArtistLookup;
    albumLocations: readonly AlbumLocation[];
    requireVisibleAlbum: boolean;
    albumOrder: "year" | "year-title";
    maxTracksPerAlbum?: number;
    /** Opt in to this owner's existing liked YT albums; omitted by shared/Subsonic reads. */
    likedRemoteAlbumsUserId?: string;
}

/** Builds the visible track predicate shared by library artist consumers. */
export function buildLibraryTrackWhere(
    albumLocations: readonly AlbumLocation[],
): Prisma.TrackWhereInput {
    return {
        ...TRACK_VISIBLE_WHERE,
        ...TRACK_BROWSE_WHERE,
        album: { location: { in: [...albumLocations] } },
    };
}

/** Builds the visible album predicate shared by library artist consumers. */
export function buildLibraryAlbumWhere(
    albumLocations: readonly AlbumLocation[],
): Prisma.AlbumWhereInput {
    const trackWhere = buildLibraryTrackWhere(albumLocations);
    return {
        location: { in: [...albumLocations] },
        tracks: { some: trackWhere },
    };
}

function buildArtistWhere(
    options: LibraryArtistReadOptions,
    albumWhere: Prisma.AlbumWhereInput,
): Prisma.ArtistWhereInput {
    const { lookup } = options;
    const identityWhere =
        lookup.name === undefined && lookup.mbid === undefined
            ? { id: lookup.id }
            : {
                  OR: [
                      { id: lookup.id },
                      ...(lookup.name === undefined
                          ? []
                          : [
                                {
                                    name: {
                                        equals: lookup.name,
                                        mode: Prisma.QueryMode.insensitive,
                                    },
                                },
                            ]),
                      ...(lookup.mbid === undefined
                          ? []
                          : [{ mbid: lookup.mbid }]),
                  ],
              };
    return options.requireVisibleAlbum
        ? { ...identityWhere, albums: { some: albumWhere } }
        : identityWhere;
}

const federationPeerSelect = {
    id: true,
    name: true,
    outboundStatus: true,
} as const;

function buildAlbumRead(
    options: LibraryArtistReadOptions,
    albumWhere: Prisma.AlbumWhereInput,
    trackWhere: Prisma.TrackWhereInput,
    likedYtWhere?: Prisma.TrackYtMusicWhereInput,
) {
    const trackTake =
        options.maxTracksPerAlbum === undefined
            ? {}
            : { take: options.maxTracksPerAlbum };
    const orderBy =
        options.albumOrder === "year-title"
            ? [{ year: Prisma.SortOrder.desc }, { title: Prisma.SortOrder.asc }]
            : [{ year: Prisma.SortOrder.desc }];
    return {
        where: albumWhere,
        orderBy,
        include: {
            federationPeer: { select: federationPeerSelect },
            ...(likedYtWhere
                ? {
                      tracksYtMusic: {
                          where: likedYtWhere,
                          orderBy: [
                              { createdAt: Prisma.SortOrder.asc },
                              { id: Prisma.SortOrder.asc },
                          ],
                          ...trackTake,
                      },
                      _count: {
                          select: { tracksYtMusic: { where: likedYtWhere } },
                      },
                  }
                : {}),
            tracks: {
                where: trackWhere,
                orderBy: [
                    { discNo: Prisma.SortOrder.asc },
                    { trackNo: Prisma.SortOrder.asc },
                ],
                ...trackTake,
                include: {
                    federationPeer: { select: federationPeerSelect },
                    album: {
                        select: {
                            id: true,
                            title: true,
                            coverUrl: true,
                            albumLoudnessLufs: true,
                            albumTruePeakDb: true,
                            artist: {
                                select: { id: true, name: true, mbid: true },
                            },
                        },
                    },
                },
            },
        },
    };
}

/**
 * Reads an artist and its visible albums for library-facing serializers.
 * Callers own transport parsing and response mapping.
 */
export async function readLibraryArtist(options: LibraryArtistReadOptions) {
    const trackWhere = buildLibraryTrackWhere(options.albumLocations);
    const visibleAlbumWhere = buildLibraryAlbumWhere(options.albumLocations);
    const likedYtWhere: Prisma.TrackYtMusicWhereInput | undefined =
        options.likedRemoteAlbumsUserId &&
        options.albumLocations.includes("REMOTE")
            ? { likedBy: { some: { userId: options.likedRemoteAlbumsUserId } } }
            : undefined;
    const albumWhere: Prisma.AlbumWhereInput = likedYtWhere
        ? {
              OR: [
                  visibleAlbumWhere,
                  { location: "REMOTE", tracksYtMusic: { some: likedYtWhere } },
              ],
          }
        : visibleAlbumWhere;
    return prisma.artist.findFirst({
        where: buildArtistWhere(options, albumWhere),
        include: {
            albums: buildAlbumRead(
                options,
                albumWhere,
                trackWhere,
                likedYtWhere,
            ),
            ownedAlbums: true,
            federationPeer: { select: federationPeerSelect },
        },
    });
}
