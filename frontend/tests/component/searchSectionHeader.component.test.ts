import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("section header keeps its result label visible without hiding content behind Show all", async () => {
    const { SearchSectionHeader } =
        await import("../../features/search/components/SearchSectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SearchSectionHeader, {
            title: "Tracks",
            description: "The strongest matches across every source",
        }),
    );

    assert.match(html, /<h2[^>]*>Tracks<\/h2>/);
    assert.match(html, /The strongest matches across every source/);
    assert.doesNotMatch(html, /Show all/);
});

test("section header can include live source status without changing its hierarchy", async () => {
    const { SearchSectionHeader } =
        await import("../../features/search/components/SearchSectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SearchSectionHeader, {
            title: "Tracks",
            status: React.createElement("span", null, "Searching online"),
        }),
    );

    assert.match(html, />Tracks<\/h2>/);
    assert.match(html, /Searching online/);
});
