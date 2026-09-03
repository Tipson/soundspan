import { spotifyPostWithDeadline } from "./spotifyRequest";
import { SpotifyPlaylistPaginationError } from "./spotifyPlaylistPagination";
import type { SpotifyPlaylist, SpotifyTrack } from "./spotifyTypes";

const SPOTIFY_PARTNER_ENDPOINT =
    "https://api-partner.spotify.com/pathfinder/v1/query";
const SPOTIFY_PLAYLIST_QUERY_HASH =
    "86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0";
const SPOTIFY_PARTNER_PAGE_SIZE = 100;
const MAX_SPOTIFY_PARTNER_PAGES = 200;
const SPOTIFY_PARTNER_TOTAL_DEADLINE_MS = 120_000;
const SPOTIFY_PARTNER_PAGE_DEADLINE_MS = 15_000;

interface SpotifyPartnerPlaylistPage {
    __typename?: unknown;
    uri?: unknown;
    name?: unknown;
    description?: unknown;
    ownerV2?: {
        data?: {
            name?: unknown;
            username?: unknown;
        };
    };
    images?: {
        items?: Array<{
            sources?: Array<{ url?: unknown }>;
        }>;
    };
    content?: {
        totalCount?: unknown;
        items?: unknown;
        pagingInfo?: {
            offset?: unknown;
            limit?: unknown;
        };
    };
}

function idFromSpotifyUri(value: unknown, entity: string): string {
    if (typeof value !== "string") return "";
    const prefix = `spotify:${entity}:`;
    return value.startsWith(prefix) ? value.slice(prefix.length) : "";
}

function mapPartnerTrack(item: any): SpotifyTrack | null {
    const track = item?.itemV2?.data;
    if (track?.__typename !== "Track") return null;

    const spotifyId = idFromSpotifyUri(track.uri, "track");
    const title = typeof track.name === "string" ? track.name.trim() : "";
    const artistEntry = track.artists?.items?.[0];
    const artist =
        typeof artistEntry?.profile?.name === "string"
            ? artistEntry.profile.name.trim()
            : "";
    if (!spotifyId || !title || !artist) return null;

    const album = track.albumOfTrack;
    const albumName =
        typeof album?.name === "string" && album.name.trim()
            ? album.name.trim()
            : "Unknown Album";
    const coverUrl = album?.coverArt?.sources?.find(
        (source: { url?: unknown }) =>
            typeof source?.url === "string" && source.url.length > 0,
    )?.url;

    return {
        spotifyId,
        title,
        artist,
        artistId: idFromSpotifyUri(artistEntry?.uri, "artist"),
        album: albumName,
        albumId: idFromSpotifyUri(album?.uri, "album"),
        isrc: null,
        durationMs: Number.isFinite(track.trackDuration?.totalMilliseconds)
            ? Math.max(0, Number(track.trackDuration.totalMilliseconds))
            : 0,
        trackNumber: Number.isSafeInteger(track.trackNumber)
            ? Math.max(0, track.trackNumber)
            : 0,
        previewUrl: null,
        coverUrl: typeof coverUrl === "string" ? coverUrl : null,
    };
}

async function fetchPartnerPage(
    playlistId: string,
    token: string,
    offset: number,
    deadlineMs: number,
): Promise<SpotifyPartnerPlaylistPage> {
    const operationName =
        offset === 0 ? "fetchPlaylist" : "fetchPlaylistContents";
    const variables: Record<string, unknown> = {
        uri: `spotify:playlist:${playlistId}`,
        offset,
        limit: SPOTIFY_PARTNER_PAGE_SIZE,
        includeEpisodeContentRatingsV2: false,
    };
    if (offset === 0) {
        variables.enableWatchFeedEntrypoint = false;
    }

    let response;
    try {
        response = await spotifyPostWithDeadline(
            SPOTIFY_PARTNER_ENDPOINT,
            {
                variables,
                operationName,
                extensions: {
                    persistedQuery: {
                        version: 1,
                        sha256Hash: SPOTIFY_PLAYLIST_QUERY_HASH,
                    },
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                },
                timeout: deadlineMs,
            },
            deadlineMs,
        );
    } catch (error) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify web-player playlist pagination failed; no partial import was created",
            { cause: error, providerFailure: true },
        );
    }

    if (Array.isArray(response.data?.errors)) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify web-player rejected the playlist request; no partial import was created",
            { providerFailure: true },
        );
    }

    const playlist = response.data?.data?.playlistV2 as
        | SpotifyPartnerPlaylistPage
        | undefined;
    if (
        playlist?.__typename !== "Playlist" ||
        !Array.isArray(playlist.content?.items)
    ) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify web-player returned a malformed playlist page; no partial import was created",
            { providerFailure: true },
        );
    }
    const returnedOffset = playlist.content?.pagingInfo?.offset;
    if (
        typeof returnedOffset === "number" &&
        Number.isSafeInteger(returnedOffset) &&
        returnedOffset !== offset
    ) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify web-player returned an unexpected playlist offset; no partial import was created",
            { providerFailure: true },
        );
    }
    return playlist;
}

function registerPartnerItemUids(
    items: unknown[],
    seenItemUids: Set<string>,
): void {
    for (const item of items) {
        const uid =
            typeof item === "object" &&
            item !== null &&
            typeof (item as { uid?: unknown }).uid === "string"
                ? (item as { uid: string }).uid
                : null;
        if (!uid) continue;
        if (seenItemUids.has(uid)) {
            throw new SpotifyPlaylistPaginationError(
                "Spotify web-player repeated a playlist page; no partial import was created",
                { providerFailure: true },
            );
        }
        seenItemUids.add(uid);
    }
}

/**
 * Fetches every item through the public web-player API when Spotify's legacy
 * public REST endpoint is quota-limited. The persisted query is deliberately
 * isolated here because Spotify may revise its web-player contract.
 */
export async function fetchSpotifyPlaylistViaPartnerApi(
    playlistId: string,
    token: string,
): Promise<SpotifyPlaylist> {
    const startedAt = Date.now();
    const firstPage = await fetchPartnerPage(
        playlistId,
        token,
        0,
        SPOTIFY_PARTNER_PAGE_DEADLINE_MS,
    );
    const declaredTotal = Number(firstPage.content?.totalCount);
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal < 0) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify web-player returned an invalid playlist total; no partial import was created",
            { providerFailure: true },
        );
    }

    const allItems = [...(firstPage.content?.items as unknown[])];
    if (declaredTotal > 0 && allItems.length === 0) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify web-player pagination ended before the declared total; no partial import was created",
            { providerFailure: true },
        );
    }
    const seenItemUids = new Set<string>();
    registerPartnerItemUids(allItems, seenItemUids);
    let pageCount = 1;
    while (allItems.length < declaredTotal) {
        if (pageCount >= MAX_SPOTIFY_PARTNER_PAGES) {
            throw new SpotifyPlaylistPaginationError(
                `Spotify playlist exceeds the safe pagination limit of ${MAX_SPOTIFY_PARTNER_PAGES} pages`,
                { providerFailure: true },
            );
        }

        const remainingDeadline =
            SPOTIFY_PARTNER_TOTAL_DEADLINE_MS - (Date.now() - startedAt);
        if (remainingDeadline <= 0) {
            throw new SpotifyPlaylistPaginationError(
                "Spotify web-player playlist pagination exceeded its total deadline; no partial import was created",
                { providerFailure: true },
            );
        }

        const page = await fetchPartnerPage(
            playlistId,
            token,
            allItems.length,
            Math.min(SPOTIFY_PARTNER_PAGE_DEADLINE_MS, remainingDeadline),
        );
        const pageTotal = Number(page.content?.totalCount);
        const pageItems = page.content?.items as unknown[];
        if (pageTotal !== declaredTotal || pageItems.length === 0) {
            throw new SpotifyPlaylistPaginationError(
                "Spotify web-player pagination ended before the declared total; no partial import was created",
                { providerFailure: true },
            );
        }
        registerPartnerItemUids(pageItems, seenItemUids);
        allItems.push(...pageItems);
        if (allItems.length > declaredTotal) {
            throw new SpotifyPlaylistPaginationError(
                "Spotify web-player returned more playlist items than declared; no partial import was created",
                { providerFailure: true },
            );
        }
        pageCount += 1;
    }

    if (allItems.length !== declaredTotal) {
        throw new SpotifyPlaylistPaginationError(
            `Spotify playlist declared ${declaredTotal} items but returned ${allItems.length}; no partial import was created`,
            { providerFailure: true },
        );
    }

    const tracks = allItems
        .map(mapPartnerTrack)
        .filter((track): track is SpotifyTrack => track !== null);
    if (declaredTotal > 0 && tracks.length === 0) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify web-player returned no importable tracks; no partial import was created",
            { providerFailure: true },
        );
    }
    const imageUrl = firstPage.images?.items?.[0]?.sources?.find(
        (source) => typeof source?.url === "string" && source.url.length > 0,
    )?.url;
    const ownerName = firstPage.ownerV2?.data?.name;
    const ownerUsername = firstPage.ownerV2?.data?.username;

    return {
        id: idFromSpotifyUri(firstPage.uri, "playlist") || playlistId,
        name:
            typeof firstPage.name === "string" && firstPage.name.trim()
                ? firstPage.name.trim()
                : "Unknown Playlist",
        description:
            typeof firstPage.description === "string"
                ? firstPage.description
                : null,
        owner:
            typeof ownerName === "string" && ownerName.trim()
                ? ownerName.trim()
                : typeof ownerUsername === "string" && ownerUsername.trim()
                  ? ownerUsername.trim()
                  : "Unknown",
        imageUrl: typeof imageUrl === "string" ? imageUrl : null,
        trackCount: tracks.length,
        tracks,
        isPublic: true,
    };
}
