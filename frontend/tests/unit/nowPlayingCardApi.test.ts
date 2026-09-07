import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComponentProps } from "react";
import type { NowPlayingCard } from "../../components/vibe/NowPlayingCard";
import type { NowPlayingConnected } from "../../components/vibe/NowPlayingConnected";

// These assignments are negative API proofs enforced by the typecheck gate.
// The deleted Wave panel must not leave unused layout switches in the map API.
type LegacyOptions = "appearance" | "showPlaybackToggle";
const cardOptionsRemoved: Extract<
    keyof ComponentProps<typeof NowPlayingCard>,
    LegacyOptions
> extends never
    ? true
    : false = true;
const connectedOptionsRemoved: Extract<
    keyof ComponentProps<typeof NowPlayingConnected>,
    LegacyOptions
> extends never
    ? true
    : false = true;

test("map card type contract excludes removed Wave layout options", () => {
    assert.equal(cardOptionsRemoved, true);
    assert.equal(connectedOptionsRemoved, true);
});
