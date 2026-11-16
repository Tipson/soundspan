import type { ScoredRecommendation } from "./types";
import { finiteQueueAdmissionRequestSchema } from "./finiteQueueAdmissionContract";
import { normalizeRecommendationArtistKey } from "./identityKeys";
import {
    hasNativeRecommendationIdentity,
    readNativeRecommendationRecording,
} from "./nativeCandidates";

const MAX_PAGE_ROWS = 75;
const MAX_CURSOR_LENGTH = 1024;
const MAX_CONTEXT_BYTES = 4096;
const MAX_ARTIST_KEY_LENGTH = 512;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SEQUENCE_POSITION = 2_147_483_647;
const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ID = /^[A-Za-z0-9_-]{1,128}$/;
type FailureCode = WaveSequenceError["code"];

function fail(code: FailureCode): never {
    throw new WaveSequenceError(code);
}

function object(value: unknown, code: FailureCode): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return fail(code);
    return value as Record<string, unknown>;
}

function exactObject(
    value: unknown,
    keys: readonly string[],
    code: FailureCode,
): Record<string, unknown> {
    const result = object(value, code);
    if (
        Object.keys(result).length !== keys.length ||
        keys.some((key) => !Object.prototype.hasOwnProperty.call(result, key))
    )
        return fail(code);
    return result;
}

function position(
    value: unknown,
    code: FailureCode,
    maximum = Number.MAX_SAFE_INTEGER,
): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > maximum
    )
        return fail(code);
    return value;
}

function readIntent(value: unknown, code: FailureCode): WaveSequenceIntent {
    const result = exactObject(value, ["direction", "mood", "language"], code);
    const { direction, mood, language } = result;
    if (
        (direction !== "for-you" &&
            direction !== "new" &&
            direction !== "familiar") ||
        (mood !== null && (typeof mood !== "string" || mood.length > 128)) ||
        (language !== "any" && language !== "ru" && language !== "foreign")
    )
        return fail(code);
    return { direction, mood, language };
}

function artistKey(value: unknown, code: FailureCode): string | null {
    if (typeof value !== "string" || value.length > MAX_ARTIST_KEY_LENGTH)
        return fail(code);
    const normalized = normalizeRecommendationArtistKey(value);
    if (normalized.length > MAX_ARTIST_KEY_LENGTH) return fail(code);
    return !normalized ||
        normalized === "unknown" ||
        normalized === "unknown artist"
        ? null
        : normalized;
}

function readReference(
    value: unknown,
    stored: boolean,
    code: FailureCode,
): WaveSequenceStoredReference {
    const result = exactObject(
        value,
        stored
            ? ["source", "id", "position", "artistKey"]
            : ["source", "id", "position"],
        code,
    );
    const parsed = finiteQueueAdmissionRequestSchema.safeParse({
        references: [{ source: result.source, id: result.id }],
    });
    if (!parsed.success) return fail(code);
    const reference = parsed.data.references[0];
    const normalizedArtist =
        stored && result.artistKey !== null
            ? artistKey(result.artistKey, code)
            : null;
    if (stored && normalizedArtist !== result.artistKey) return fail(code);
    return {
        source: reference.source,
        id: reference.id,
        position: position(result.position, code, MAX_SEQUENCE_POSITION),
        artistKey: normalizedArtist,
    };
}

function readStoredTail(
    value: unknown,
    nextPosition: number,
    code: FailureCode,
): WaveSequenceStoredReference[] {
    if (!Array.isArray(value) || value.length !== Math.min(2, nextPosition))
        return fail(code);
    const tail = value.map((reference) => readReference(reference, true, code));
    for (let index = 0; index < tail.length; index++)
        if (tail[index].position !== nextPosition - tail.length + index)
            return fail(code);
    return tail;
}

function readContext(value: unknown): WaveSequenceContextV1 {
    const code = "invalid_cursor";
    const result = exactObject(
        value,
        [
            "version",
            "sequenceId",
            "nextPosition",
            "nextSourceCursor",
            "intent",
            "tail",
        ],
        code,
    );
    if (
        result.version !== 1 ||
        typeof result.sequenceId !== "string" ||
        !UUID.test(result.sequenceId)
    )
        return fail(code);
    const nextPosition = position(
        result.nextPosition,
        code,
        MAX_SEQUENCE_POSITION,
    );
    const context: WaveSequenceContextV1 = {
        version: 1,
        sequenceId: result.sequenceId,
        nextPosition,
        nextSourceCursor: position(result.nextSourceCursor, code),
        intent: readIntent(result.intent, code),
        tail: readStoredTail(result.tail, nextPosition, code),
    };
    if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_CONTEXT_BYTES)
        return fail(code);
    return context;
}

function readCursor(value: unknown): WaveSequenceCursorV1 {
    const code = "invalid_cursor";
    const result = exactObject(
        value,
        [
            "version",
            "generationId",
            "sequenceId",
            "nextPosition",
            "nextSourceCursor",
        ],
        code,
    );
    if (
        result.version !== 1 ||
        typeof result.generationId !== "string" ||
        !STABLE_ID.test(result.generationId) ||
        typeof result.sequenceId !== "string" ||
        !UUID.test(result.sequenceId)
    )
        return fail(code);
    return {
        version: 1,
        generationId: result.generationId,
        sequenceId: result.sequenceId,
        nextPosition: position(
            result.nextPosition,
            code,
            MAX_SEQUENCE_POSITION,
        ),
        nextSourceCursor: position(result.nextSourceCursor, code),
    };
}

function rowReference(
    row: ScoredRecommendation,
    sequencePosition: number,
): WaveSequenceStoredReference {
    const code = "invalid_tail";
    if (!row || !row.track || row.track.source !== row.track.streamSource)
        return fail(code);
    const track = row.track;
    let source = track.source;
    let id: unknown;
    if (hasNativeRecommendationIdentity(track)) {
        const native = readNativeRecommendationRecording(track);
        if (!native) return fail(code);
        source = native.provider;
        id = native.id;
    } else if (source === "library") {
        if (
            track.provider?.youtubeVideoId != null ||
            track.youtubeVideoId != null ||
            track.provider?.tidalTrackId != null ||
            track.tidalTrackId != null
        )
            return fail(code);
        id = track.id;
    } else if (source === "youtube") {
        if (
            track.provider?.tidalTrackId != null ||
            track.tidalTrackId != null ||
            (track.youtubeVideoId !== undefined &&
                track.youtubeVideoId !== track.provider?.youtubeVideoId)
        )
            return fail(code);
        id = track.provider?.youtubeVideoId;
    } else if (source === "tidal") {
        if (
            track.provider?.youtubeVideoId != null ||
            track.youtubeVideoId != null
        )
            return fail(code);
        const tidal = track.provider?.tidalTrackId;
        if (typeof tidal !== "number" || !Number.isSafeInteger(tidal))
            return fail(code);
        id = String(tidal);
    } else return fail(code);
    return readReference(
        {
            source,
            id,
            position: sequencePosition,
            artistKey: artistKey(track.artist?.name, code),
        },
        true,
        code,
    );
}

/** An exact occurrence in a server-owned Wave sequence. */
export interface WaveSequenceReference {
    source: "library" | "youtube" | "tidal" | "vk" | "yandex";
    id: string;
    position: number;
}

/** Server-derived credit retained only for the last two sequence positions. */
export interface WaveSequenceStoredReference extends WaveSequenceReference {
    artistKey: string | null;
}

/** Effective ordering intent; a continuation must retain all three values. */
export interface WaveSequenceIntent {
    direction: "for-you" | "new" | "familiar";
    mood: string | null;
    language: "any" | "ru" | "foreign";
}

/** Bounded context stored in RecommendationGeneration.context.orderedWave. */
export interface WaveSequenceContextV1 {
    version: 1;
    sequenceId: string;
    nextPosition: number;
    nextSourceCursor: number;
    intent: WaveSequenceIntent;
    tail: WaveSequenceStoredReference[];
}

/** Opaque continuation locator; the server generation row authenticates it. */
export interface WaveSequenceCursorV1 {
    version: 1;
    generationId: string;
    sequenceId: string;
    nextPosition: number;
    nextSourceCursor: number;
}

/** A static protocol failure suitable for a reset/400 boundary. */
export class WaveSequenceError extends Error {
    constructor(
        readonly code:
            | "invalid_cursor"
            | "invalid_tail"
            | "expired"
            | "intent_changed",
    ) {
        super(code);
        this.name = "WaveSequenceError";
    }
}

/** Build the context before the single served-generation write. */
export function createWaveSequenceContext(input: {
    ordered: readonly ScoredRecommendation[];
    sequenceId: string;
    startPosition: number;
    nextSourceCursor: number;
    verifiedPreviousTail: readonly WaveSequenceStoredReference[];
    intent: WaveSequenceIntent;
    check?: () => void;
}): WaveSequenceContextV1 {
    const check = input.check ?? (() => {});
    check();
    if (!Array.isArray(input.ordered) || input.ordered.length > MAX_PAGE_ROWS)
        return fail("invalid_tail");
    const start = position(
        input.startPosition,
        "invalid_cursor",
        MAX_SEQUENCE_POSITION,
    );
    const nextPosition = position(
        start + input.ordered.length,
        "invalid_cursor",
        MAX_SEQUENCE_POSITION,
    );
    const tail = readStoredTail(
        input.verifiedPreviousTail,
        start,
        "invalid_tail",
    );
    for (const [index, row] of input.ordered.entries()) {
        check();
        tail.push(rowReference(row, start + index));
        if (tail.length > 2) tail.shift();
    }
    check();
    return readContext({
        version: 1,
        sequenceId: input.sequenceId,
        nextPosition,
        nextSourceCursor: input.nextSourceCursor,
        intent: input.intent,
        tail,
    });
}

/** Encode only after persistence supplies the actual served generation ID. */
export function encodeWaveSequenceCursor(
    generationId: string,
    context: WaveSequenceContextV1,
    check?: () => void,
): string {
    check?.();
    const stored = readContext(context);
    const cursor = readCursor({
        version: 1,
        generationId,
        sequenceId: stored.sequenceId,
        nextPosition: stored.nextPosition,
        nextSourceCursor: stored.nextSourceCursor,
    });
    const raw = Buffer.from(JSON.stringify(cursor), "utf8").toString(
        "base64url",
    );
    if (raw.length > MAX_CURSOR_LENGTH) return fail("invalid_cursor");
    check?.();
    return raw;
}

/** Parse the bounded canonical base64url cursor before generation lookup. */
export function parseWaveSequenceCursor(
    raw: unknown,
    check?: () => void,
): WaveSequenceCursorV1 {
    check?.();
    if (
        typeof raw !== "string" ||
        raw.length === 0 ||
        raw.length > MAX_CURSOR_LENGTH ||
        !/^[A-Za-z0-9_-]+$/.test(raw)
    )
        return fail("invalid_cursor");
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) return fail("invalid_cursor");
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString("utf8"));
    } catch {
        return fail("invalid_cursor");
    }
    const cursor = readCursor(value);
    check?.();
    return cursor;
}

/** Verify a continuation against the actual owned served generation row. */
export function validateWaveSequenceContinuation(input: {
    cursor: WaveSequenceCursorV1;
    tail: unknown;
    generation: {
        id: string;
        userId: string;
        sessionId: string;
        surface: string;
        served: boolean;
        createdAt: Date;
        context: unknown;
    };
    userId: string;
    sessionId: string;
    intent: WaveSequenceIntent;
    now: Date;
    check?: () => void;
}): WaveSequenceContextV1 {
    const check = input.check ?? (() => {});
    check();
    const cursor = readCursor(input.cursor);
    const generation = input.generation;
    if (
        !generation ||
        generation.id !== cursor.generationId ||
        generation.userId !== input.userId ||
        generation.sessionId !== input.sessionId ||
        generation.surface !== "wave" ||
        generation.served !== true
    )
        return fail("invalid_cursor");
    const namespace = object(generation.context, "invalid_cursor");
    const trusted = readContext(namespace.orderedWave);
    if (
        trusted.sequenceId !== cursor.sequenceId ||
        trusted.nextPosition !== cursor.nextPosition ||
        trusted.nextSourceCursor !== cursor.nextSourceCursor
    )
        return fail("invalid_cursor");
    if (
        !(generation.createdAt instanceof Date) ||
        !(input.now instanceof Date) ||
        !Number.isFinite(generation.createdAt.getTime()) ||
        !Number.isFinite(input.now.getTime()) ||
        input.now.getTime() < generation.createdAt.getTime() ||
        input.now.getTime() - generation.createdAt.getTime() >= MAX_AGE_MS
    )
        return fail("expired");
    const intent = readIntent(input.intent, "intent_changed");
    if (
        intent.direction !== trusted.intent.direction ||
        intent.mood !== trusted.intent.mood ||
        intent.language !== trusted.intent.language
    )
        return fail("intent_changed");
    if (!Array.isArray(input.tail) || input.tail.length !== trusted.tail.length)
        return fail("invalid_tail");
    for (let index = 0; index < input.tail.length; index++) {
        check();
        const given = readReference(input.tail[index], false, "invalid_tail");
        const stored = trusted.tail[index];
        if (
            given.source !== stored.source ||
            given.id !== stored.id ||
            given.position !== stored.position
        )
            return fail("invalid_tail");
    }
    check();
    return trusted;
}
