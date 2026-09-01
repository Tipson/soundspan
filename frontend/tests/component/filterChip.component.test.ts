import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("filter chip exposes selected state for button interactions", async () => {
    const { FilterChip } = await import("../../components/ui/FilterChip");
    const html = renderToStaticMarkup(
        React.createElement(
            FilterChip,
            { active: true } as React.ComponentProps<typeof FilterChip>,
            "Tracks",
        ),
    );

    assert.match(html, /type="button"/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /data-state="active"/);
    assert.match(html, />Tracks</);
});

test("filter chip keeps deep-link state discoverable", async () => {
    const { FilterChip } = await import("../../components/ui/FilterChip");
    const html = renderToStaticMarkup(
        React.createElement(
            FilterChip,
            {
                active: false,
                href: "/search?q=Linkin%20Park&view=albums",
            } as React.ComponentProps<typeof FilterChip>,
            "Albums",
        ),
    );

    assert.match(html, /href="\/search\?q=Linkin%20Park&amp;view=albums"/);
    assert.match(html, /data-state="inactive"/);
    assert.doesNotMatch(html, /aria-current=/);
});

test("active linked chip marks the current result view", async () => {
    const { FilterChip } = await import("../../components/ui/FilterChip");
    const html = renderToStaticMarkup(
        React.createElement(
            FilterChip,
            {
                active: true,
                href: "/search?q=Linkin%20Park&view=tracks",
            } as React.ComponentProps<typeof FilterChip>,
            "Tracks",
        ),
    );

    assert.match(html, /aria-current="page"/);
    assert.match(html, /data-state="active"/);
});
