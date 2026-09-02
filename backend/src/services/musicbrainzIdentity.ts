import { isPlainObject } from "../utils/plainObject";
import { isValidMbid } from "../utils/musicIds";

/** Accept an ISRC lookup only when it identifies exactly one recording. */
export function parseRecordingMbidFromIsrcLookup(
    value: unknown,
): string | null {
    if (!isPlainObject(value) || !Array.isArray(value.recordings)) return null;
    const ids = Array.from(
        new Set(
            value.recordings.flatMap((recording) => {
                if (!isPlainObject(recording) || !isValidMbid(recording.id)) {
                    return [];
                }
                return [recording.id];
            }),
        ),
    );
    return ids.length === 1 ? ids[0] : null;
}
