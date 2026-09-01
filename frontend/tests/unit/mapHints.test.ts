import assert from "node:assert/strict";
import test from "node:test";
import { hintForMode } from "../../components/vibe/mapHints";

test("each mode gets its own verb hint", () => {
    assert.match(hintForMode("explore"), /Нажмите на точку/);
    assert.match(hintForMode("explore"), /Shift \+ клик/);
    assert.match(hintForMode("travel"), /светящийся контур/);
    assert.match(hintForMode("travel"), /Esc — выйти/);
    assert.match(hintForMode("journey"), /трек или настроение/);
    assert.match(hintForMode("alchemy"), /от 2 до 10 треков/);
});

test("journey picking narrows the hint to the pick action", () => {
    assert.match(
        hintForMode("journey", { picking: true }),
        /Нажмите на любую точку, чтобы выбрать цель маршрута/,
    );
});

test("an armed brush overrides every mode hint", () => {
    for (const mode of ["explore", "travel", "journey", "alchemy"] as const) {
        assert.match(hintForMode(mode, { sweepArmed: true }), /Кисть включена/);
    }
});
