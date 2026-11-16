import { createHash } from "node:crypto";
import { z } from "zod";
import type { ScrobbleService } from "./scrobbleTypes";

/** Secret-free wakeup; database ownership and claim state remain authoritative. */
export const scrobbleDispatchWakeSchema = z.strictObject({
    version: z.literal(1),
    dispatchId: z.string().regex(/^[a-f0-9]{64}$/),
    userId: z.string().min(1).max(128),
});

/** Bounded resolved metadata, with no credential, private source snapshot or URL. */
export const scrobbleDispatchTrackSchema = z.strictObject({
    artist: z.string().min(1).max(1_000),
    title: z.string().min(1).max(1_000),
    album: z.string().max(1_000).optional(),
    durationSeconds: z.number().int().nonnegative().max(604_800).optional(),
});

/** Dispatch identity cannot migrate to a replacement authorization generation. */
export function playScrobbleDispatchId(
    playId: string,
    connectionId: string,
    authEpoch: number,
): string {
    if (
        !Number.isInteger(authEpoch) ||
        authEpoch < 0 ||
        authEpoch > 2_147_483_647
    )
        throw new RangeError("Invalid scrobble authorization epoch");
    return createHash("sha256")
        .update(
            JSON.stringify([1, playId, connectionId, authEpoch, "scrobble"]),
        )
        .digest("hex");
}

/** No provider retry permission is inferred from a transport response. */
export type ScrobbleDispatchAck =
    | "submitted"
    | "rejected"
    | "invalid_auth"
    | "ambiguous";
const count = z
    .union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")])
    .transform(Number);
const ignoredCode = z
    .union([z.number().int().min(0).max(9_999), z.string().regex(/^\d{1,4}$/)])
    .transform(Number);
const scrobbleAck = z.object({
    ignoredMessage: z.object({ code: ignoredCode }),
});
const lastFmAck = z.object({
    scrobbles: z.object({
        "@attr": z.object({ accepted: count, ignored: count }),
        scrobble: z.union([scrobbleAck, z.array(scrobbleAck).length(1)]),
    }),
});

/** Validates documented single-submission ACKs; opaque provider content is discarded. */
export function decodeScrobbleDispatchAck(
    service: ScrobbleService,
    status: number,
    data: unknown,
): ScrobbleDispatchAck {
    if (status === 401) return "invalid_auth";
    if (status !== 200) return "ambiguous";
    if (service === "listenbrainz")
        return z.strictObject({ status: z.literal("ok") }).safeParse(data)
            .success
            ? "submitted"
            : "ambiguous";
    const auth = z
        .object({ error: z.union([z.literal(4), z.literal(9)]) })
        .safeParse(data);
    if (
        typeof data === "object" &&
        data !== null &&
        Object.prototype.hasOwnProperty.call(data, "error")
    ) {
        return auth.success &&
            !Object.prototype.hasOwnProperty.call(data, "scrobbles")
            ? "invalid_auth"
            : "ambiguous";
    }
    const result = lastFmAck.safeParse(data);
    if (!result.success) return "ambiguous";
    const { scrobbles } = result.data;
    const response = Array.isArray(scrobbles.scrobble)
        ? scrobbles.scrobble[0]
        : scrobbles.scrobble;
    const { accepted, ignored } = scrobbles["@attr"];
    if (accepted === 1 && ignored === 0 && response.ignoredMessage.code === 0)
        return "submitted";
    if (accepted === 0 && ignored === 1 && response.ignoredMessage.code !== 0)
        return "rejected";
    return "ambiguous";
}
