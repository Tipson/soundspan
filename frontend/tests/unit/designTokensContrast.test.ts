import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    AA_NORMAL,
    compositeOver,
    contrastRatio,
    DESIGN_TOKENS,
    NON_TEXT,
    relativeLuminance,
} from "../../styles/tokens";
import {
    SETTINGS_FIELD_FOCUS_RING,
    SETTINGS_FOCUS_RING_TOKEN,
} from "../../features/settings/components/ui/settingsFieldStyles";

const globalsCss = readFileSync(
    new URL("../../app/globals.css", import.meta.url),
    "utf8",
);
const themeBlock = globalsCss.match(/@theme\s*\{([^}]*)\}/)?.[1];

assert.ok(themeBlock, "globals.css must contain an @theme block");

const themeColors = Object.fromEntries(
    [...themeBlock.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6});/g)].map(
        ([, name, hex]) => [name, hex.toLowerCase()],
    ),
);

test("globals.css @theme stays synchronized with DESIGN_TOKENS", () => {
    for (const [name, hex] of Object.entries(DESIGN_TOKENS)) {
        assert.equal(
            themeColors[name],
            hex,
            `--color-${name} must equal ${hex}`,
        );
    }
});

test("text and brand tokens meet the normal-text contrast floor", () => {
    for (const foreground of [
        DESIGN_TOKENS["content-muted"],
        DESIGN_TOKENS["content-secondary"],
        DESIGN_TOKENS["content-body"],
        DESIGN_TOKENS.brand,
        DESIGN_TOKENS["brand-hover"],
        "#9ca3af",
    ]) {
        assert.ok(
            contrastRatio(foreground, DESIGN_TOKENS.surface) >= AA_NORMAL,
        );
    }
});

test("the spectral-stage palette stays on the approved semantic values", () => {
    assert.deepEqual(
        {
            canvas: DESIGN_TOKENS.surface,
            stage: DESIGN_TOKENS["surface-raised"],
            surface: DESIGN_TOKENS["surface-elevated"],
            active: DESIGN_TOKENS["surface-active"],
            ink: DESIGN_TOKENS.content,
            muted: DESIGN_TOKENS["content-muted"],
            signal: DESIGN_TOKENS.brand,
        },
        {
            canvas: "#080a0f",
            stage: "#11151d",
            surface: "#1a202a",
            active: "#222a36",
            ink: "#f7f8fc",
            muted: "#aeb6c5",
            signal: "#8fa8ff",
        },
    );
});

test("secondary copy remains readable on every shared application surface", () => {
    const surfaces = [
        DESIGN_TOKENS.surface,
        DESIGN_TOKENS["surface-raised"],
        DESIGN_TOKENS["surface-elevated"],
        DESIGN_TOKENS["surface-active"],
    ];

    for (const foreground of [
        DESIGN_TOKENS["content-muted"],
        DESIGN_TOKENS["content-secondary"],
        DESIGN_TOKENS["content-body"],
    ]) {
        for (const background of surfaces) {
            assert.ok(
                contrastRatio(foreground, background) >= AA_NORMAL,
                `${foreground} must remain readable on ${background}`,
            );
        }
    }
});

test("gray-500 and gray-600 document contrast failures on surface", () => {
    assert.ok(contrastRatio("#6b7280", DESIGN_TOKENS.surface) < AA_NORMAL);
    assert.ok(contrastRatio("#4b5563", DESIGN_TOKENS.surface) < AA_NORMAL);
});

test("settings focus ring token meets non-text contrast", () => {
    assert.equal(
        SETTINGS_FIELD_FOCUS_RING,
        "focus:outline-none focus:ring-2 focus:ring-brand-hover",
    );
    assert.ok(SETTINGS_FOCUS_RING_TOKEN in DESIGN_TOKENS);
    assert.ok(
        contrastRatio(
            DESIGN_TOKENS[SETTINGS_FOCUS_RING_TOKEN],
            DESIGN_TOKENS["line-muted"],
        ) >= NON_TEXT,
    );
});

test("old translucent white settings focus ring fails non-text contrast", () => {
    const focusedInput = DESIGN_TOKENS["line-muted"];
    const oldRing = compositeOver("#ffffff", focusedInput, 0.2);

    assert.ok(contrastRatio(oldRing, focusedInput) < NON_TEXT);
});

test("color helpers reject malformed hex and out-of-range alpha", () => {
    assert.throws(() => relativeLuminance("#fff"), TypeError);
    assert.throws(() => contrastRatio("not-a-color", "#000000"), TypeError);
    assert.throws(() => compositeOver("#ffffff", "#000000", -0.01), RangeError);
    assert.throws(() => compositeOver("#ffffff", "#000000", 1.01), RangeError);
});
