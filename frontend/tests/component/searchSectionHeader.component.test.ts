import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("overview section header exposes an explicit Show all destination", async () => {
    const { SearchSectionHeader } =
        await import("../../features/search/components/SearchSectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SearchSectionHeader, {
            title: "Tracks",
            showAllHref: "/search?q=massive%20attack&view=tracks",
        }),
    );

    assert.match(html, /<h2[^>]*>Tracks<\/h2>/);
    assert.match(
        html,
        /href="\/search\?q=massive%20attack&amp;view=tracks"[^>]*>Show all<\/a>/,
    );
});

test("dedicated result view omits the redundant Show all action", async () => {
    const { SearchSectionHeader } =
        await import("../../features/search/components/SearchSectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SearchSectionHeader, { title: "Tracks" }),
    );

    assert.match(html, />Tracks<\/h2>/);
    assert.doesNotMatch(html, /Show all/);
});
