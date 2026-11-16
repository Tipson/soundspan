import { z } from "zod";

const referenceSchema = z
    .object({
        source: z.enum(["library", "youtube", "tidal", "vk", "yandex"]),
        id: z.string().min(1).max(128),
        generationId: z.string().min(1).max(128).optional(),
    })
    .strict()
    .refine(
        ({ source, id }) => {
            if (source === "library") return /^[A-Za-z0-9_-]{1,128}$/.test(id);
            if (source === "youtube") return /^[A-Za-z0-9_-]{11}$/.test(id);
            if (source === "vk") return /^-?\d{1,20}_\d{1,20}$/.test(id);
            if (source === "yandex")
                return /^\d{1,20}$/.test(id) && /[1-9]/.test(id);
            return (
                /^[1-9]\d{0,19}$/.test(id) && Number.isSafeInteger(Number(id))
            );
        },
        { message: "Invalid provider recording reference", path: ["id"] },
    );

/** A finite identity-only batch; the bound applies before duplicate references are coalesced. */
export const finiteQueueAdmissionRequestSchema = z
    .object({ references: z.array(referenceSchema).min(1).max(100) })
    .strict();

/** Stable recording identity with optional owner-served generation context. */
export type FiniteQueueAdmissionReference = z.infer<typeof referenceSchema>;

/** A request-local result, never a new durable preference or identity assertion. */
export interface FiniteQueueAdmissionDecision {
    source: FiniteQueueAdmissionReference["source"];
    id: string;
    state: "allowed" | "denied" | "unavailable";
}

/** Ordered occurrence decisions apply only to future automatic recommendations. */
export interface FiniteQueueAdmissionResponse {
    version: 1;
    appliesTo: "recommended_future";
    decisions: FiniteQueueAdmissionDecision[];
}
