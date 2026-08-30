import type { Album, Track } from "./types";

/** Artist-page content views supported by the `view` query parameter. */
export type ArtistView = "overview" | "tracks" | "albums" | "singles";

const ARTIST_VIEWS = new Set<ArtistView>([
    "overview",
    "tracks",
    "albums",
    "singles",
]);

/** Resolve an untrusted query-string value to a supported artist view. */
export function resolveArtistView(value: string | null): ArtistView {
    return value && ARTIST_VIEWS.has(value as ArtistView)
        ? (value as ArtistView)
        : "overview";
}

/** Return whether a release is explicitly identified as a single or EP. */
export function isSingleOrEpRelease(release: Pick<Album, "type">): boolean {
    const type = release.type?.trim().toLowerCase();
    if (!type) return false;
    return type === "ep" || type === "extended play" || type.includes("single");
}

/** Filter releases for a dedicated artist view without guessing untyped items. */
export function filterArtistReleases<T extends Pick<Album, "type">>(
    releases: T[],
    view: ArtistView,
): T[] {
    if (view === "albums") {
        return releases.filter((release) => !isSingleOrEpRelease(release));
    }
    if (view === "singles") {
        return releases.filter(isSingleOrEpRelease);
    }
    return releases;
}

function trackIdentity(track: Track): string {
    const artist = track.artist?.name?.trim().toLocaleLowerCase() ?? "";
    return `${artist}::${track.title.trim().toLocaleLowerCase()}`;
}

/** Keep provider popularity order while appending every unique library track. */
export function mergeArtistTracks(
    popularTracks: Track[],
    libraryTracks: Track[],
): Track[] {
    const merged: Track[] = [];
    const positions = new Map<string, number>();

    for (const track of [...popularTracks, ...libraryTracks]) {
        const keys = [`id:${track.id}`, `title:${trackIdentity(track)}`];
        const existingIndex = keys
            .map((key) => positions.get(key))
            .find((index) => index !== undefined);
        if (existingIndex !== undefined) {
            const existing = merged[existingIndex];
            if (!existing.filePath && track.filePath) {
                merged[existingIndex] = {
                    ...existing,
                    ...track,
                    playCount: existing.playCount ?? track.playCount,
                    listeners: existing.listeners ?? track.listeners,
                };
            }
            continue;
        }

        const index = merged.length;
        merged.push(track);
        for (const key of keys) positions.set(key, index);
    }

    return merged;
}
