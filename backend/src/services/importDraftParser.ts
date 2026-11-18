import { createHash } from "node:crypto";

/** Maximum decoded file bytes; the enclosing HTTP body retains its existing bound. */
export const IMPORT_DRAFT_MAX_BYTES = 512 * 1024;
export const IMPORT_DRAFT_MAX_ENTRIES = 1000;
export const IMPORT_DRAFT_CATEGORIES = [
    "playlists",
    "likes",
    "albums",
    "artists",
    "dislikes",
] as const;
export type ImportDraftCategory = (typeof IMPORT_DRAFT_CATEGORIES)[number];
export interface ImportDraftUpload {
    format: "text" | "spotify-json";
    content: string;
    name?: string;
    textCategory?: "playlists" | "likes" | "dislikes";
}
export interface ImportDraftSourceReference {
    source: "spotify" | "youtube" | "library";
    type: "track" | "album" | "artist";
    entityId: string;
}
export interface ImportDraftEntry {
    id: string;
    category: ImportDraftCategory;
    groupId: string | null;
    position: number;
    artist: string;
    title: string;
    album: string | null;
    sourceRef: ImportDraftSourceReference | null;
    unresolvedReason: "missing_artist" | "missing_source_identity" | null;
}
export interface NormalizedImportDraft {
    version: 1;
    format: ImportDraftUpload["format"];
    sourceHash: string;
    name: string;
    groups: Array<{ id: string; name: string }>;
    entries: ImportDraftEntry[];
}

/** Code-owned failure labels; neither raw source content nor provider errors escape. */
export class ImportDraftError extends Error {
    constructor(
        public readonly code: string,
        public readonly status = 400,
    ) {
        super(code);
        this.name = "ImportDraftError";
    }
}

/** Normalize an uploaded music export without creating any account effects. */
export function parseImportDraftUpload(input: unknown): NormalizedImportDraft {
    if (
        !record(input) ||
        !["text", "spotify-json"].includes(String(input.format)) ||
        typeof input.content !== "string"
    ) {
        throw new ImportDraftError("import_file_invalid");
    }
    if (Buffer.byteLength(input.content, "utf8") > IMPORT_DRAFT_MAX_BYTES)
        throw new ImportDraftError("import_file_too_large", 413);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.content))
        throw new ImportDraftError("import_file_invalid");
    const format = input.format as ImportDraftUpload["format"];
    const textCategory = input.textCategory ?? "playlists";
    if (!["playlists", "likes", "dislikes"].includes(String(textCategory)))
        throw new ImportDraftError("import_category_invalid");
    const name =
        input.name === undefined
            ? format === "text"
                ? "Text import"
                : "Spotify import"
            : text(input.name, 200);
    const content = input.content.replace(/^\uFEFF/, "");
    const result: NormalizedImportDraft = {
        version: 1,
        format,
        name,
        sourceHash: importDraftDigest([format, textCategory, input.content]),
        groups: [],
        entries: [],
    };
    const add = (entry: Omit<ImportDraftEntry, "id">) => {
        if (result.entries.length >= IMPORT_DRAFT_MAX_ENTRIES)
            throw new ImportDraftError("import_file_too_many_entries", 413);
        result.entries.push({ id: `e${result.entries.length}`, ...entry });
    };
    if (format === "text") {
        const category = textCategory as "playlists" | "likes" | "dislikes";
        if (category === "playlists") result.groups.push({ id: "p0", name });
        let position = 0;
        for (const raw of content.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith("#")) continue;
            let artist = "",
                title = line,
                sourceRef: ImportDraftSourceReference | null = null;
            const columns = line.split("\t");
            if (columns.length === 2) [artist, title] = columns;
            else if (columns.length === 3) {
                sourceRef = exactTextReference(columns[0]);
                [artist, title] = columns.slice(1);
            } else if (columns.length > 3)
                throw new ImportDraftError("import_file_invalid");
            else {
                const parts = /^(.*?)\s[-–—]\s(.+)$/.exec(line);
                if (parts) [, artist, title] = parts;
            }
            artist = text(artist, 300, true);
            title = text(title, 300);
            add({
                category,
                groupId: category === "playlists" ? "p0" : null,
                position: position++,
                artist,
                title,
                album: null,
                sourceRef,
                unresolvedReason: artist ? null : "missing_artist",
            });
        }
    } else {
        let exported: unknown;
        try {
            exported = JSON.parse(content);
        } catch {
            throw new ImportDraftError("import_file_invalid");
        }
        if (!record(exported))
            throw new ImportDraftError("import_file_invalid");
        for (const [groupIndex, raw] of arrayField(
            exported,
            "playlists",
        ).entries()) {
            if (groupIndex >= 100)
                throw new ImportDraftError("import_file_too_many_groups", 413);
            if (!record(raw)) throw new ImportDraftError("import_file_invalid");
            const id = `p${groupIndex}`;
            result.groups.push({ id, name: text(raw.name, 200) });
            const items = arrayField(raw, "items", true);
            for (const [position, item] of items.entries()) {
                if (!record(item) || !record(item.track))
                    throw new ImportDraftError("import_file_invalid");
                add(trackEntry(item.track, "playlists", position, id));
            }
        }
        for (const [key, category] of [["tracks", "likes"]] as const) {
            for (const [position, row] of arrayField(exported, key).entries()) {
                if (!record(row))
                    throw new ImportDraftError("import_file_invalid");
                add(trackEntry(row, category, position, null));
            }
        }
        for (const [key, type] of [
            ["albums", "album"],
            ["artists", "artist"],
        ] as const) {
            for (const [position, row] of arrayField(exported, key).entries()) {
                if (!record(row))
                    throw new ImportDraftError("import_file_invalid");
                const title = text(
                    type === "artist"
                        ? (row.name ?? row.artist)
                        : (row.album ?? row.albumName),
                    300,
                );
                const sourceRef = spotifyReference(
                    row.uri ?? row[`${type}Uri`],
                    type,
                );
                add({
                    category: key,
                    position,
                    groupId: null,
                    title,
                    artist:
                        type === "artist"
                            ? title
                            : text(
                                  row.artist ?? row.artistName ?? "",
                                  300,
                                  true,
                              ),
                    album: null,
                    sourceRef,
                    unresolvedReason: sourceRef
                        ? null
                        : "missing_source_identity",
                });
            }
        }
        for (const [position, row] of arrayField(
            exported,
            "bannedTracks",
        ).entries()) {
            if (!record(row)) throw new ImportDraftError("import_file_invalid");
            add(trackEntry(row, "dislikes", position, null));
        }
    }
    if (result.entries.length === 0)
        throw new ImportDraftError("import_file_empty");
    return result;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, maximum: number, empty = false): string {
    if (typeof value !== "string")
        throw new ImportDraftError("import_file_invalid");
    const normalized = value.trim().normalize("NFC");
    if (
        (!empty && !normalized) ||
        normalized.length > maximum ||
        /[\u0000-\u001f\u007f]/.test(normalized)
    )
        throw new ImportDraftError("import_file_invalid");
    return normalized;
}
function arrayField(
    row: Record<string, unknown>,
    key: string,
    required = false,
): unknown[] {
    if (row[key] === undefined && !required) return [];
    if (!Array.isArray(row[key]))
        throw new ImportDraftError("import_file_invalid");
    return row[key];
}
function spotifyReference(
    value: unknown,
    type: ImportDraftSourceReference["type"],
): ImportDraftSourceReference | null {
    if (value === undefined || value === null || value === "") return null;
    const raw = text(value, 512);
    let id = new RegExp(`^spotify:${type}:([A-Za-z0-9]{1,64})$`).exec(raw)?.[1];
    if (!id) {
        try {
            const url = new URL(raw);
            if (
                url.protocol === "https:" &&
                url.hostname === "open.spotify.com" &&
                !url.username &&
                !url.password
            )
                id = new RegExp(`^/${type}/([A-Za-z0-9]{1,64})/?$`).exec(
                    url.pathname,
                )?.[1];
        } catch {
            /* Not an accepted provider identity. */
        }
    }
    if (!id) throw new ImportDraftError("import_source_identity_invalid");
    return { source: "spotify", type, entityId: id };
}
function exactTextReference(value: string): ImportDraftSourceReference {
    const match = /^(yt|library):([A-Za-z0-9_-]{1,128})$/.exec(value.trim());
    if (!match || (match[1] === "yt" && match[2].length > 64))
        throw new ImportDraftError("import_source_identity_invalid");
    return {
        source: match[1] === "yt" ? "youtube" : "library",
        type: "track",
        entityId: match[2],
    };
}
function trackEntry(
    row: Record<string, unknown>,
    category: "playlists" | "likes" | "dislikes",
    position: number,
    groupId: string | null,
): Omit<ImportDraftEntry, "id"> {
    const artist = text(row.artistName ?? row.artist ?? "", 300, true);
    const album = row.albumName ?? row.album;
    return {
        category,
        groupId,
        position,
        artist,
        title: text(row.trackName ?? row.track, 300),
        album:
            album === undefined || album === null || album === ""
                ? null
                : text(album, 300),
        sourceRef: spotifyReference(row.trackUri ?? row.uri, "track"),
        unresolvedReason: artist ? null : "missing_artist",
    };
}

/** Stable digest of code-owned normalized input or a persisted matching snapshot. */
export function importDraftDigest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
