import { z } from "zod";
import {
    IMPORT_DRAFT_CATEGORIES,
    IMPORT_DRAFT_MAX_ENTRIES,
    ImportDraftError,
    importDraftDigest,
    type NormalizedImportDraft,
} from "./importDraftParser";

const name = z.string().min(1).max(300);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z
    .object({
        source: z.enum(["spotify", "youtube", "library"]),
        type: z.enum(["track", "album", "artist"]),
        entityId: z.string().min(1).max(128),
    })
    .strict();
const normalizedSchema = z
    .object({
        version: z.literal(1),
        format: z.enum(["text", "spotify-json"]),
        sourceHash: digest,
        name: z.string().min(1).max(200),
        groups: z
            .array(
                z
                    .object({
                        id: z.string().regex(/^p\d+$/),
                        name: z.string().min(1).max(200),
                    })
                    .strict(),
            )
            .max(100),
        entries: z
            .array(
                z
                    .object({
                        id: z.string().regex(/^e\d+$/),
                        category: z.enum(IMPORT_DRAFT_CATEGORIES),
                        groupId: z.string().nullable(),
                        position: z.number().int().min(0),
                        artist: z.string().max(300),
                        title: name,
                        album: z.string().max(300).nullable(),
                        sourceRef: reference.nullable(),
                        unresolvedReason: z
                            .enum(["missing_artist", "missing_source_identity"])
                            .nullable(),
                    })
                    .strict(),
            )
            .min(1)
            .max(IMPORT_DRAFT_MAX_ENTRIES),
    })
    .strict();

/** A read-only match; remote provider metadata is materialized only after confirmation. */
export interface ImportDraftMatch {
    source: "local" | "youtube" | "unresolved";
    confidence: number;
    trackId?: string;
    videoId?: string;
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
}
const matchSchema = z
    .object({
        source: z.enum(["local", "youtube", "unresolved"]),
        confidence: z.number().finite().min(0).max(100),
        trackId: z.string().min(1).max(128).optional(),
        videoId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,64}$/)
            .optional(),
        title: name.optional(),
        artist: name.optional(),
        album: z.string().max(300).optional(),
        duration: z.number().int().min(0).max(86400).optional(),
    })
    .strict()
    .superRefine((match, ctx) => {
        if (
            (match.source === "local" && (!match.trackId || match.videoId)) ||
            (match.source === "youtube" &&
                (!match.videoId ||
                    !match.title ||
                    !match.artist ||
                    match.trackId)) ||
            (match.source === "unresolved" && (match.trackId || match.videoId))
        )
            ctx.addIssue({ code: "custom", message: "Match identity" });
    });
const previewRowSchema = z
    .object({
        entryId: z.string(),
        match: matchSchema.nullable(),
        confidence: z.number().finite().min(0).max(100),
        negativeId: z.string().min(1).max(256).nullable(),
        unresolvedReason: z
            .string()
            .regex(/^[a-z_]{1,64}$/)
            .nullable(),
    })
    .strict();
const previewSchema = z
    .object({
        revision: z.number().int().min(1),
        previewRevision: z.number().int().min(1),
        mappingDigest: digest,
        rows: z.array(previewRowSchema).min(1).max(IMPORT_DRAFT_MAX_ENTRIES),
    })
    .strict();
const draftSchema = z
    .object({
        version: z.literal(1),
        normalized: normalizedSchema,
        preview: previewSchema.nullable(),
    })
    .strict();
const confirmationSchema = z
    .object({
        version: z.literal(1),
        revision: z.number().int().min(1),
        previewRevision: z.number().int().min(1),
        sourceHash: digest,
        mappingDigest: digest,
        categories: z.array(z.enum(IMPORT_DRAFT_CATEGORIES)).min(1).max(5),
        confirmedAt: z.number().int().min(1),
        normalized: normalizedSchema,
        preview: previewSchema,
    })
    .strict();
export type ImportDraftPreviewRow = z.infer<typeof previewRowSchema>;
export type ImportDraftPreview = z.infer<typeof previewSchema>;
export type ImportDraftData = z.infer<typeof draftSchema>;
export type ConfirmedImportDraft = z.infer<typeof confirmationSchema>;

/** Build a revision-bound, detached matching snapshot with a server-owned digest. */
export function buildImportDraftPreview(
    normalized: NormalizedImportDraft,
    revision: number,
    previewRevision: number,
    rows: ImportDraftPreviewRow[],
): ImportDraftPreview {
    const parsed = previewSchema.parse({
        revision,
        previewRevision,
        mappingDigest: "0".repeat(64),
        rows,
    });
    parsed.mappingDigest = importDraftDigest([
        normalized.sourceHash,
        revision,
        previewRevision,
        parsed.rows,
    ]);
    return parsed;
}

/** Decode and validate journal snapshots before their identities can authorize effects. */
export function readImportDraftData(value: unknown): ImportDraftData {
    const parsed = draftSchema.safeParse(value);
    if (!parsed.success)
        throw new ImportDraftError("import_draft_snapshot_invalid", 409);
    const draft = parsed.data;
    validateNormalized(draft.normalized);
    if (draft.preview) validatePreview(draft.normalized, draft.preview);
    return draft;
}
/** Decode the immutable selected source/matching snapshot; never read IDs from confirm input. */
export function readConfirmedImportDraft(value: unknown): ConfirmedImportDraft {
    const parsed = confirmationSchema.safeParse(value);
    if (!parsed.success)
        throw new ImportDraftError("import_draft_snapshot_invalid", 409);
    const confirmed = parsed.data;
    validateNormalized(confirmed.normalized);
    validatePreview(confirmed.normalized, confirmed.preview);
    if (
        confirmed.revision !== confirmed.preview.revision ||
        confirmed.previewRevision !== confirmed.preview.previewRevision ||
        confirmed.sourceHash !== confirmed.normalized.sourceHash ||
        confirmed.mappingDigest !== confirmed.preview.mappingDigest ||
        new Set(confirmed.categories).size !== confirmed.categories.length
    )
        throw new ImportDraftError("import_draft_snapshot_invalid", 409);
    return confirmed;
}
function validateNormalized(normalized: NormalizedImportDraft): void {
    const groups = new Set(normalized.groups.map((group) => group.id));
    if (
        groups.size !== normalized.groups.length ||
        normalized.entries.some(
            (entry, index) =>
                entry.id !== `e${index}` ||
                (entry.category === "playlists"
                    ? !groups.has(entry.groupId ?? "")
                    : entry.groupId !== null),
        )
    )
        throw new ImportDraftError("import_draft_snapshot_invalid", 409);
    for (const group of normalized.groups) {
        if (
            normalized.entries
                .filter((entry) => entry.groupId === group.id)
                .some((entry, position) => entry.position !== position)
        )
            throw new ImportDraftError("import_draft_snapshot_invalid", 409);
    }
}
function validatePreview(
    normalized: NormalizedImportDraft,
    preview: ImportDraftPreview,
): void {
    if (
        preview.rows.length !== normalized.entries.length ||
        preview.rows.some(
            (row, index) => row.entryId !== normalized.entries[index].id,
        ) ||
        preview.mappingDigest !==
            importDraftDigest([
                normalized.sourceHash,
                preview.revision,
                preview.previewRevision,
                preview.rows,
            ])
    )
        throw new ImportDraftError("import_draft_snapshot_invalid", 409);
    for (const [index, row] of preview.rows.entries()) {
        if (row.negativeId === null) continue;
        const entry = normalized.entries[index];
        const exact = entry.sourceRef;
        const expected =
            exact?.source === "youtube"
                ? `yt:${exact.entityId}`
                : exact?.source === "library" &&
                    row.match?.source === "local" &&
                    row.match.trackId === exact.entityId
                  ? exact.entityId
                  : null;
        if (expected !== row.negativeId)
            throw new ImportDraftError("import_draft_snapshot_invalid", 409);
    }
}
