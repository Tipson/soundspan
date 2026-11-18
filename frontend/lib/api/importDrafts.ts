import type { ImportJob } from "../api";

/** Independently selected account effects; no category is selected by default. */
export type ImportDraftCategory =
    | "playlists"
    | "likes"
    | "albums"
    | "artists"
    | "dislikes";
export interface ImportDraftUpload {
    format: "text" | "spotify-json";
    content: string;
    name?: string;
    textCategory?: "playlists" | "likes" | "dislikes";
}
/** One original source occurrence, including repetitions and unresolved entries. */
export interface ImportDraftEntry {
    id: string;
    category: ImportDraftCategory;
    groupId: string | null;
    position: number;
    artist: string;
    title: string;
    album: string | null;
    sourceRef: {
        source: "spotify" | "youtube" | "library";
        type: "track" | "album" | "artist";
        entityId: string;
    } | null;
    unresolvedReason: string | null;
}
export interface ImportDraftPreview {
    revision: number;
    previewRevision: number;
    mappingDigest: string;
    rows: Array<{
        entryId: string;
        confidence: number;
        match: {
            source: "local" | "youtube" | "unresolved";
            confidence: number;
        } | null;
        negativeId: string | null;
        unresolvedReason: string | null;
    }>;
}
/** Only server preview tokens and explicit categories cross the confirm boundary. */
export interface ImportDraftConfirmation {
    revision: number;
    previewRevision: number;
    mappingDigest: string;
    categories: ImportDraftCategory[];
}
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
}
/** Durable owner draft returned by the existing import journal. */
export interface ImportDraftJob extends ImportJob {
    draftRevision: number;
    draftData: {
        version: 1;
        normalized: {
            version: 1;
            format: ImportDraftUpload["format"];
            sourceHash: string;
            name: string;
            groups: Array<{ id: string; name: string }>;
            entries: ImportDraftEntry[];
        };
        preview: ImportDraftPreview | null;
    };
    confirmedSnapshot:
        | (ImportDraftConfirmation & { version: 1; confirmedAt: number })
        | null;
    draftResult: ImportDraftResult | null;
}
