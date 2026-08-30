/**
 * mapHints — PURE selection of the one-line contextual hint the map whispers
 * at bottom-center. The map's grammar is modifier-key verbs (shift-drag,
 * ctrl-click) that are otherwise invisible; the hint chip teaches exactly the
 * verbs that matter in the current mode, and nothing else.
 *
 * No React, no DOM — unit-testable in isolation.
 */

import type { MapMode } from "./types";
import { vibeMapRu } from "@/lib/i18n/vibeMapRu";

export const HINTS_DISMISSED_KEY = "vibe:hints-dismissed";

export interface HintContext {
    /** Journey's "pick on map" sub-state. */
    picking?: boolean;
    /** The sweep brush toggle is armed. */
    sweepArmed?: boolean;
}

export function hintForMode(mode: MapMode, ctx: HintContext = {}): string {
    if (ctx.sweepArmed) {
        return vibeMapRu.hints.brush;
    }
    switch (mode) {
        case "travel":
            return vibeMapRu.hints.travel;
        case "journey":
            return ctx.picking
                ? vibeMapRu.hints.journeyPick
                : vibeMapRu.hints.journey;
        case "alchemy":
            return vibeMapRu.hints.alchemy;
        case "explore":
        default:
            return vibeMapRu.hints.explore;
    }
}
