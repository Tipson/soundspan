import { prisma } from "../utils/db";
import { isRealArtistMbid, isValidMbid } from "../utils/musicIds";
import {
    normalizeForExactKey,
    VARIOUS_ARTISTS_MBID,
} from "../utils/artistNormalization";
import {
    musicBrainzService,
    type MusicBrainzReleaseGroupSearchResult,
} from "./musicbrainz";
import { pickRemoteAlbumMbidMatch } from "./remoteAlbumMbidMatch";
import {
    albumMatchInputHash,
    REMOTE_ALBUM_NEGATIVE_MATCH_MS,
    REMOTE_ALBUM_POSITIVE_MATCH_MS,
} from "./remoteAlbumMatchInput";

export { albumMatchInputHash } from "./remoteAlbumMatchInput";
const MAX_BATCH = 25,
    LOOKUP_TIMEOUT_MS = 15_000,
    RUN_BUDGET_MS = 60_000;
let active = false;
let lookupSlot: Promise<MusicBrainzReleaseGroupSearchResult[]> | null = null;
let cursor: string | null = null;

interface AlbumCandidate {
    id: string;
    rgMbid: string;
    title: string;
    artistId: string;
    location: string;
    artist: { name: string; mbid: string };
    matchedRgMbid: string | null;
    rgMbidCheckedAt: Date | null;
    rgMbidMatchInputHash: string | null;
    tracksYtMusic: Array<{ title: string }>;
}

/** Outcomes from one bounded maintenance pass over existing liked REMOTE albums. */
export interface RemoteAlbumMbidResolutionResult {
    scanned: number;
    matched: number;
    missed: number;
    skipped: number;
    errors: number;
}

function artistMatches(
    album: AlbumCandidate,
    group: MusicBrainzReleaseGroupSearchResult,
): boolean {
    const credits = group["artist-credit"];
    if (!Array.isArray(credits)) return false;
    const mbid = album.artist.mbid;
    if (mbid && isRealArtistMbid(mbid))
        return credits.some((c) => c?.artist?.id === mbid);
    const name = normalizeForExactKey(album.artist.name);
    return (
        Boolean(name) &&
        credits.some(
            (c) =>
                normalizeForExactKey(c?.artist?.name ?? c?.name ?? "") === name,
        )
    );
}

async function lookup(album: AlbumCandidate, timeoutMs: number) {
    const work = musicBrainzService.searchReleaseGroupsForAlbumIdentity(
        album.title,
        album.artist.name,
    );
    lookupSlot = work;
    void work
        .finally(() => {
            if (lookupSlot === work) lookupSlot = null;
        })
        .catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error("Album identity lookup deadline")),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function storeMatch(
    album: AlbumCandidate,
    matchedRgMbid: string | null,
    inputHash: string,
    now: Date,
    deadline: number,
): Promise<{ count: number }> {
    const budget = Math.min(5_000, Math.floor(deadline - Date.now()));
    if (budget < 1) throw new Error("Album identity write admission deadline");
    let callbackWork: Promise<{ count: number }> | undefined;
    try {
        return await prisma.$transaction(
            (tx) => {
                callbackWork = (async () => {
                    const remaining = Math.min(
                        budget,
                        Math.floor(deadline - Date.now()),
                    );
                    if (remaining < 1)
                        throw new Error("Album identity write deadline");
                    // Only this row-locking CAS is guarded. These parameterized GUCs
                    // share its connection and expire on COMMIT/ROLLBACK, not the pool.
                    await tx.$queryRaw`SELECT set_config('lock_timeout', ${String(Math.max(1, Math.floor(remaining * 0.8)))}, true), set_config('statement_timeout', ${String(remaining)}, true)`;
                    if (Date.now() >= deadline)
                        throw new Error("Album identity write deadline");
                    const changed = await tx.album.updateMany({
                        where: {
                            id: album.id,
                            rgMbid: album.rgMbid,
                            title: album.title,
                            artistId: album.artistId,
                            location: "REMOTE",
                            artist: {
                                name: album.artist.name,
                                mbid: album.artist.mbid,
                            },
                            matchedRgMbid: album.matchedRgMbid,
                            rgMbidCheckedAt: album.rgMbidCheckedAt,
                            rgMbidMatchInputHash: album.rgMbidMatchInputHash,
                        },
                        data: {
                            matchedRgMbid,
                            rgMbidCheckedAt: now,
                            rgMbidMatchInputHash: inputHash,
                        },
                    });
                    if (Date.now() >= deadline)
                        throw new Error("Album identity write deadline");
                    return changed;
                })();
                return callbackWork;
            },
            { maxWait: budget, timeout: budget },
        );
    } finally {
        // ITX may reject before an in-flight driver call settles. Keep this run's
        // active slot until the callback finishes; never race into a late commit.
        await callbackWork?.catch(() => undefined);
    }
}

/**
 * Resolve one fair page without changing exact provider identities. Sixty seconds
 * govern admission; driver work is awaited to settlement, not a hard wall-clock SLA.
 */
export async function resolveRemoteAlbumMbids({
    batchSize = MAX_BATCH,
    now = new Date(),
}: {
    batchSize?: number;
    now?: Date;
} = {}): Promise<RemoteAlbumMbidResolutionResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH)
        throw new RangeError("batchSize must be between 1 and 25");
    if (!Number.isFinite(now.getTime()))
        throw new RangeError("Invalid matching clock");
    const result: RemoteAlbumMbidResolutionResult = {
        scanned: 0,
        matched: 0,
        missed: 0,
        skipped: 0,
        errors: 0,
    };
    if (active || lookupSlot) {
        result.skipped++;
        return result;
    }
    active = true;
    const deadline = Date.now() + RUN_BUDGET_MS;
    try {
        const albums: AlbumCandidate[] = await prisma.album.findMany({
            where: {
                location: "REMOTE",
                rgMbid: { startsWith: "remote:" },
                tracksYtMusic: { some: { likedBy: { some: {} } } },
                ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: "asc" },
            take: batchSize,
            select: {
                id: true,
                rgMbid: true,
                title: true,
                artistId: true,
                location: true,
                artist: { select: { name: true, mbid: true } },
                matchedRgMbid: true,
                rgMbidCheckedAt: true,
                rgMbidMatchInputHash: true,
                tracksYtMusic: {
                    where: { likedBy: { some: {} } },
                    take: 50,
                    select: { title: true },
                },
            },
        });
        // A cursor prevents a page of fresh cached rows from starving a changed
        // album later in the table. Each run still reads at most one small page.
        cursor =
            albums.length === batchSize ? albums[albums.length - 1].id : null;
        let failures = 0;
        for (const album of albums) {
            if (Date.now() >= deadline || lookupSlot) break;
            result.scanned++;
            const inputHash = albumMatchInputHash(album),
                ttl = album.matchedRgMbid
                    ? REMOTE_ALBUM_POSITIVE_MATCH_MS
                    : REMOTE_ALBUM_NEGATIVE_MATCH_MS;
            if (
                album.rgMbidMatchInputHash === inputHash &&
                album.rgMbidCheckedAt &&
                now.getTime() - album.rgMbidCheckedAt.getTime() >= 0 &&
                now.getTime() - album.rgMbidCheckedAt.getTime() < ttl
            ) {
                result.skipped++;
                continue;
            }
            if (
                !album.title.trim() ||
                album.title.length > 500 ||
                !album.artist.name.trim() ||
                album.artist.name.length > 200 ||
                album.artist.mbid === VARIOUS_ARTISTS_MBID ||
                normalizeForExactKey(album.artist.name) ===
                    normalizeForExactKey("Various Artists")
            ) {
                result.skipped++;
                continue;
            }
            try {
                const groups = await lookup(
                    album,
                    Math.min(LOOKUP_TIMEOUT_MS, deadline - Date.now()),
                );
                if (Date.now() >= deadline) {
                    result.skipped++;
                    break;
                }
                if (!Array.isArray(groups) || groups.length > 25)
                    throw new TypeError("Invalid album identity candidates");
                const match = pickRemoteAlbumMbidMatch(
                    album.title,
                    groups.map((g) => ({
                        rgMbid: g.id,
                        title: g.title,
                        primaryType: g["primary-type"] ?? "",
                        artistMatches: artistMatches(album, g),
                        score:
                            g.score === undefined ? undefined : Number(g.score),
                        secondaryTypes: g["secondary-types"],
                    })),
                    {
                        allowSingle: album.tracksYtMusic.some(
                            (t) =>
                                normalizeForExactKey(t.title) ===
                                normalizeForExactKey(album.title),
                        ),
                    },
                );
                const changed = await storeMatch(
                    album,
                    match && isValidMbid(match.rgMbid) ? match.rgMbid : null,
                    inputHash,
                    now,
                    deadline,
                );
                if (!changed.count) result.skipped++;
                else if (match) result.matched++;
                else result.missed++;
                failures = 0;
            } catch {
                result.errors++;
                if (++failures >= 3 || lookupSlot) break;
            }
        }
        return result;
    } finally {
        active = false;
    }
}
