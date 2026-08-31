import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsRow } from "../../features/settings/components/ui/SettingsRow";
import { SettingsToggle } from "../../features/settings/components/ui/SettingsToggle";

function labelledToggleMarkup({ id }: { id?: string } = {}): string {
    type SettingsRowWithoutChildren = Omit<
        React.ComponentProps<typeof SettingsRow>,
        "children"
    >;
    const TestSettingsRow =
        SettingsRow as React.ComponentType<SettingsRowWithoutChildren>;
    const toggle = React.createElement(SettingsToggle, {
        id,
        checked: false,
        onChange: () => undefined,
    });

    return renderToStaticMarkup(
        React.createElement(
            TestSettingsRow,
            {
                label: "Показывать, что я слушаю",
                description: "Друзья смогут видеть текущий трек.",
            },
            toggle,
        ),
    );
}

test("settings toggle inherits the row accessible name when it has an id", () => {
    const html = labelledToggleMarkup({ id: "share-listening-status" });
    const labelId = html.match(
        /<span id="([^"]+)"[^>]*>Показывать, что я слушаю<\/span>/,
    )?.[1];
    assert.ok(labelId);
    const input = html.match(
        /<input[^>]*id="share-listening-status"[^>]*>/,
    )?.[0];
    assert.ok(input);
    assert.match(input, new RegExp(`aria-labelledby="${labelId}"`));
});

test("settings toggle without an id still inherits the row accessible name", () => {
    const html = labelledToggleMarkup();
    const labelId = html.match(
        /<span id="([^"]+)"[^>]*>Показывать, что я слушаю<\/span>/,
    )?.[1];
    assert.ok(labelId);
    const input = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    assert.ok(input);
    assert.match(input, new RegExp(`aria-labelledby="${labelId}"`));
});
