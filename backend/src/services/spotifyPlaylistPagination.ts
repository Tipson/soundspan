import axios from "axios";

/** Classifies Spotify pagination failures without exposing provider details. */
export class SpotifyPlaylistPaginationError extends Error {
    readonly providerFailure: boolean;
    readonly allowsAnonymousFallback: boolean;

    constructor(
        message: string,
        options: ErrorOptions & {
            providerFailure?: boolean;
            allowsAnonymousFallback?: boolean;
        } = {},
    ) {
        super(message, options);
        this.name = "SpotifyPlaylistPaginationError";
        this.providerFailure = options.providerFailure ?? false;
        this.allowsAnonymousFallback = options.allowsAnonymousFallback ?? false;
    }

    /** Returns only a message constructed by this pagination module. */
    codeOwnedMessage(): string {
        return this.message;
    }
}

const MAX_PLAYLIST_PAGES = 200;

function parseSpotifyPlaylistItemsUrl(
    nextUrl: string,
    playlistId: string,
    endpoint: "items" | "compat",
): URL {
    let parsedNextUrl: URL;
    try {
        parsedNextUrl = new URL(nextUrl);
    } catch (error) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify returned an invalid playlist pagination link",
            { cause: error },
        );
    }

    const expectedItemsPath = `/v1/playlists/${playlistId}/items`;
    const expectedLegacyPath = `/v1/playlists/${playlistId}/tracks`;
    const isExpectedPath =
        parsedNextUrl.pathname === expectedItemsPath ||
        (endpoint === "compat" &&
            parsedNextUrl.pathname === expectedLegacyPath);
    if (
        parsedNextUrl.protocol !== "https:" ||
        parsedNextUrl.hostname !== "api.spotify.com" ||
        parsedNextUrl.port !== "" ||
        parsedNextUrl.username !== "" ||
        parsedNextUrl.password !== "" ||
        parsedNextUrl.hash !== "" ||
        !isExpectedPath
    ) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify returned an unsafe playlist pagination link",
        );
    }

    return parsedNextUrl;
}

export async function fetchAllSpotifyPlaylistItems(
    initialPage: any,
    playlistId: string,
    token: string,
    endpoint: "items" | "compat" = "compat",
): Promise<any[]> {
    if (!initialPage || !Array.isArray(initialPage.items)) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify returned a malformed initial playlist page",
            { allowsAnonymousFallback: true },
        );
    }
    if (
        initialPage.next !== null &&
        initialPage.next !== undefined &&
        typeof initialPage.next !== "string"
    ) {
        throw new SpotifyPlaylistPaginationError(
            "Spotify returned a malformed initial playlist link",
            { allowsAnonymousFallback: true },
        );
    }

    const items = [...initialPage.items];
    const seenPageUrls = new Set<string>();
    let nextUrl =
        typeof initialPage?.next === "string" && initialPage.next.length > 0
            ? initialPage.next
            : null;
    let pageCount = 1;

    while (nextUrl) {
        if (pageCount >= MAX_PLAYLIST_PAGES) {
            throw new SpotifyPlaylistPaginationError(
                `Spotify playlist exceeds the safe pagination limit of ${MAX_PLAYLIST_PAGES} pages`,
            );
        }
        if (seenPageUrls.has(nextUrl)) {
            throw new SpotifyPlaylistPaginationError(
                "Spotify returned a cyclic playlist pagination link",
            );
        }

        parseSpotifyPlaylistItemsUrl(nextUrl, playlistId, endpoint);
        seenPageUrls.add(nextUrl);

        let pageResponse;
        try {
            pageResponse = await axios.get(nextUrl, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                },
                timeout: 15000,
            });
        } catch (error) {
            throw new SpotifyPlaylistPaginationError(
                "Spotify playlist pagination failed; no partial import was created",
                { cause: error, providerFailure: true },
            );
        }

        const page = pageResponse.data;
        if (!Array.isArray(page?.items)) {
            throw new SpotifyPlaylistPaginationError(
                "Spotify returned a malformed playlist page",
            );
        }
        if (
            page.next !== null &&
            page.next !== undefined &&
            typeof page.next !== "string"
        ) {
            throw new SpotifyPlaylistPaginationError(
                "Spotify returned a malformed playlist pagination link",
            );
        }
        items.push(...page.items);
        nextUrl =
            typeof page.next === "string" && page.next.length > 0
                ? page.next
                : null;
        pageCount += 1;
    }

    const declaredTotal = Number(initialPage?.total);
    if (
        Number.isSafeInteger(declaredTotal) &&
        declaredTotal >= 0 &&
        items.length !== declaredTotal
    ) {
        throw new SpotifyPlaylistPaginationError(
            `Spotify playlist declared ${declaredTotal} items but returned ${items.length}; no partial import was created`,
        );
    }

    return items;
}
