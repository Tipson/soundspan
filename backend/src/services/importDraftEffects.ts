import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import {
    LOCAL_AUDIO_ANALYSIS_TRACK_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../utils/librarySorting";
import { buildGenericImportPlaylistMixId } from "./genericImportIdentity";
import type {
    ConfirmedImportDraft,
    ImportDraftMatch,
} from "./importDraftSnapshot";
import type {
    ImportDraftCategory,
    ImportDraftEntry,
} from "./importDraftParser";

/** Private committed receipt. It is never a synthetic listening or download event. */
export interface ImportDraftResult {
    version: 1;
    playlistIds: string[];
    likes: number;
    albums: number;
    artists: number;
    dislikes: number;
    unresolved: Array<{
        entryId: string;
        category: ImportDraftCategory;
        reason: string;
    }>;
    skipped: Array<{
        entryId: string;
        category: ImportDraftCategory;
        reason: string;
    }>;
    invalidationPending: boolean;
    invalidationScopes: string[];
}
type Reference =
    | { trackId: string; trackYtMusicId?: never; negativeId: string }
    | { trackId?: never; trackYtMusicId: string; negativeId: string };

/** Apply selected effects inside the caller's journal-locked transaction. */
export async function persistImportDraftEffects(
    tx: Prisma.TransactionClient,
    userId: string,
    jobId: string,
    snapshot: ConfirmedImportDraft,
): Promise<ImportDraftResult> {
    const result: ImportDraftResult = {
        version: 1,
        playlistIds: [],
        likes: 0,
        albums: 0,
        artists: 0,
        dislikes: 0,
        unresolved: [],
        skipped: [],
        invalidationPending: true,
        invalidationScopes: ["playlists", "liked", "saved", "recommendations"],
    };
    const selected = new Set(snapshot.categories);
    const entries = snapshot.normalized.entries.filter((entry) =>
        selected.has(entry.category),
    );
    const rows = new Map(
        snapshot.preview.rows.map((row) => [row.entryId, row]),
    );
    const unresolved = (entry: ImportDraftEntry, reason: string) =>
        result.unresolved.push({
            entryId: entry.id,
            category: entry.category,
            reason,
        });
    const skipped = (entry: ImportDraftEntry) =>
        result.skipped.push({
            entryId: entry.id,
            category: entry.category,
            reason: "existing_preference",
        });
    const localIds = [
        ...new Set(
            entries.flatMap(
                (entry) => rows.get(entry.id)?.match?.trackId ?? [],
            ),
        ),
    ];
    const visible = new Set(
        (
            await tx.track.findMany({
                where: {
                    id: { in: localIds },
                    AND: [
                        LOCAL_AUDIO_ANALYSIS_TRACK_WHERE,
                        TRACK_VISIBLE_WHERE,
                    ],
                },
                select: { id: true },
            })
        ).map((track) => track.id),
    );
    const refs = new Map<string, Reference>();
    const youtubeRows = new Map<string, string>();
    for (const entry of entries) {
        if (entry.category !== "playlists" && entry.category !== "likes")
            continue;
        const match = rows.get(entry.id)?.match;
        if (
            match?.source === "local" &&
            match.trackId &&
            visible.has(match.trackId)
        )
            refs.set(entry.id, {
                trackId: match.trackId,
                negativeId: match.trackId,
            });
        else if (
            match?.source === "youtube" &&
            match.videoId &&
            match.title &&
            match.artist
        ) {
            let id = youtubeRows.get(match.videoId);
            if (!id) {
                const row = await tx.trackYtMusic.upsert({
                    where: { videoId: match.videoId },
                    update: {},
                    create: {
                        videoId: match.videoId,
                        title: match.title,
                        artist: match.artist,
                        album: match.album ?? "",
                        duration: match.duration ?? 0,
                    },
                    select: { id: true },
                });
                id = row.id;
                youtubeRows.set(match.videoId, id);
            }
            refs.set(entry.id, {
                trackYtMusicId: id,
                negativeId: `yt:${match.videoId}`,
            });
        }
    }
    if (selected.has("playlists")) {
        for (const group of snapshot.normalized.groups) {
            const mixId = buildGenericImportPlaylistMixId(
                `${jobId}:draft:${group.id}`,
            );
            let playlist = await tx.playlist.findUnique({
                where: { userId_mixId: { userId, mixId } },
                select: { id: true },
            });
            if (!playlist) {
                playlist = await tx.playlist.create({
                    data: { userId, mixId, name: group.name },
                    select: { id: true },
                });
                const members = entries.filter(
                    (entry) =>
                        entry.category === "playlists" &&
                        entry.groupId === group.id,
                );
                const resolved = members.flatMap((entry) => {
                    const ref = refs.get(entry.id);
                    return ref
                        ? [
                              {
                                  playlistId: playlist!.id,
                                  trackId: ref.trackId ?? null,
                                  trackYtMusicId: ref.trackYtMusicId ?? null,
                                  sort: entry.position,
                              },
                          ]
                        : [];
                });
                if (
                    resolved.length &&
                    (await tx.playlistItem.createMany({ data: resolved }))
                        .count !== resolved.length
                )
                    throw new Error("Import item persistence incomplete");
                const pending = members.filter((entry) => !refs.has(entry.id));
                if (
                    pending.length &&
                    (
                        await tx.playlistPendingTrack.createMany({
                            data: pending.map((entry) => ({
                                playlistId: playlist!.id,
                                spotifyArtist: entry.artist,
                                spotifyTitle: entry.title,
                                spotifyAlbum: entry.album ?? "",
                                sort: entry.position,
                            })),
                        })
                    ).count !== pending.length
                )
                    throw new Error("Import pending persistence incomplete");
                pending.forEach((entry) =>
                    unresolved(
                        entry,
                        rows.get(entry.id)?.unresolvedReason ??
                            "match_unavailable",
                    ),
                );
            }
            result.playlistIds.push(playlist.id);
        }
    }
    for (const entry of entries) {
        if (entry.category === "albums" || entry.category === "artists") {
            const ref = entry.sourceRef,
                entityType = entry.category === "albums" ? "album" : "artist";
            if (!ref || ref.type !== entityType) {
                unresolved(entry, "missing_source_identity");
                continue;
            }
            const identity = {
                userId,
                entityType,
                source: ref.source,
                entityId: ref.entityId,
            };
            await tx.savedMusicEntity.upsert({
                where: { userId_entityType_source_entityId: identity },
                update: {},
                create: {
                    ...identity,
                    title: entry.title,
                    subtitle:
                        entry.artist && entry.artist !== entry.title
                            ? entry.artist
                            : null,
                    imageUrl: null,
                },
            });
            result[entry.category]++;
        } else if (entry.category === "likes") {
            const ref = refs.get(entry.id);
            if (!ref) {
                unresolved(entry, "match_unavailable");
                continue;
            }
            const negativeAliases = ref.negativeId.startsWith("yt:")
                ? [ref.negativeId, ref.negativeId.slice(3)]
                : [ref.negativeId];
            const opposite = await tx.dislikedEntity.findFirst({
                where: {
                    userId,
                    entityType: "track",
                    entityId: { in: negativeAliases },
                },
                select: { id: true },
            });
            const intent = ref.trackYtMusicId
                ? await tx.remotePreferenceIntent.findUnique({
                      where: {
                          userId_remoteTrackId: {
                              userId,
                              remoteTrackId: ref.negativeId,
                          },
                      },
                      select: { token: true },
                  })
                : null;
            if (opposite || intent) {
                skipped(entry);
                continue;
            }
            if (ref.trackId)
                await tx.likedTrack.upsert({
                    where: { userId_trackId: { userId, trackId: ref.trackId } },
                    update: {},
                    create: {
                        userId,
                        trackId: ref.trackId,
                        likedAt: new Date(snapshot.confirmedAt),
                    },
                });
            else
                await tx.likedRemoteTrack.upsert({
                    where: {
                        userId_trackYtMusicId: {
                            userId,
                            trackYtMusicId: ref.trackYtMusicId!,
                        },
                    },
                    update: {},
                    create: {
                        userId,
                        trackYtMusicId: ref.trackYtMusicId!,
                        likedAt: new Date(snapshot.confirmedAt),
                    },
                });
            result.likes++;
        } else if (entry.category === "dislikes") {
            const negativeId = rows.get(entry.id)?.negativeId;
            if (
                !negativeId ||
                (!negativeId.startsWith("yt:") && !visible.has(negativeId))
            ) {
                unresolved(entry, "exact_negative_unavailable");
                continue;
            }
            const youtube = negativeId.startsWith("yt:")
                ? await tx.trackYtMusic.findUnique({
                      where: { videoId: negativeId.slice(3) },
                      select: { id: true },
                  })
                : null;
            const liked = negativeId.startsWith("yt:")
                ? youtube &&
                  (await tx.likedRemoteTrack.findUnique({
                      where: {
                          userId_trackYtMusicId: {
                              userId,
                              trackYtMusicId: youtube.id,
                          },
                      },
                  }))
                : await tx.likedTrack.findUnique({
                      where: {
                          userId_trackId: { userId, trackId: negativeId },
                      },
                  });
            const intent = negativeId.startsWith("yt:")
                ? await tx.remotePreferenceIntent.findUnique({
                      where: {
                          userId_remoteTrackId: {
                              userId,
                              remoteTrackId: negativeId,
                          },
                      },
                  })
                : null;
            if (liked || intent) {
                skipped(entry);
                continue;
            }
            const identity = {
                userId,
                entityType: "track",
                entityId: negativeId,
            };
            await tx.dislikedEntity.upsert({
                where: { userId_entityType_entityId: identity },
                update: {},
                create: {
                    ...identity,
                    dislikedAt: new Date(snapshot.confirmedAt),
                },
            });
            result.dislikes++;
        }
    }
    const eventId = `import-draft-${createHash("sha256")
        .update(JSON.stringify([userId, jobId]))
        .digest("hex")}`;
    await tx.notification.upsert({
        where: { id: eventId },
        update: {},
        create: {
            id: eventId,
            userId,
            type: "import_complete",
            title: "Import Complete",
            message: "Confirmed import selections have been processed",
            metadata: {
                version: 1,
                kind: "import_draft",
                jobId,
                revision: snapshot.revision,
                playlistIds: result.playlistIds,
                invalidationScopes: result.invalidationScopes,
            },
        },
    });
    return result;
}
